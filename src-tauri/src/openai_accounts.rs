use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::State;
use url::{Host, Url};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const SCHEMA_VERSION: u8 = 1;
const ACCOUNT_KIND: &str = "provider_account";
const MAX_LABEL_LENGTH: usize = 64;
const MIN_API_KEY_LENGTH: usize = 8;
const MAX_API_KEY_LENGTH: usize = 512;
const MAX_BASE_URL_LENGTH: usize = 2_048;
const CONNECTION_TIMEOUT_SECONDS: u64 = 10;
const MODEL_CATALOG_TIMEOUT_SECONDS: u64 = 15;
const MAX_MODEL_CATALOG_BYTES: usize = 4_000_000;
const MAX_MODEL_CATALOG_PAGES: usize = 10;
const MAX_MODEL_ID_LENGTH: usize = 256;
const GEMINI_TRANSLATION_MODEL_IDS: [&str; 7] = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
    "gemini-3-flash-preview",
];
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    OpenAi,
    Gemini,
}

impl Provider {
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Gemini => "Gemini",
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountSummary {
    pub file_name: String,
    pub label: String,
    pub provider: Provider,
    pub base_url: String,
    pub is_active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountState {
    pub accounts: Vec<ProviderAccountSummary>,
    pub active_account_file: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConnectionOutcome {
    Connected,
    RateLimited,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionTestResult {
    pub outcome: ProviderConnectionOutcome,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSummary {
    pub id: String,
    pub display_name: Option<String>,
}

#[derive(Debug)]
struct ProviderModelPage {
    models: Vec<ProviderModelSummary>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModelsResponse {
    #[serde(default)]
    models: Vec<GeminiModel>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModel {
    name: String,
    display_name: Option<String>,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

pub struct ProviderAccountStore {
    root: PathBuf,
    mutation_lock: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct ProviderRuntimeAccount {
    pub(crate) api_key: String,
    pub(crate) base_url: String,
}

impl ProviderAccountStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            mutation_lock: Mutex::new(()),
        }
    }

    pub fn list(&self, provider: Provider) -> Result<ProviderAccountState, String> {
        let _guard = self.lock()?;
        self.ensure_layout()?;
        self.list_unlocked(provider)
    }

    pub fn create(
        &self,
        provider: Provider,
        label: &str,
        api_key: &str,
        base_url: &str,
    ) -> Result<ProviderAccountState, String> {
        let _guard = self.lock()?;
        self.ensure_layout()?;
        let label = validate_label(label)?;
        let api_key = validate_api_key(api_key)?;
        let base_url = validate_base_url(provider, base_url)?;
        let mut config = self.read_config_for_mutation()?;
        let slug = slugify_label(&label);
        let account = StoredProviderAccount::new(provider, label, api_key, Some(base_url));

        let mut created_file = None;
        for suffix in 1..=10_000 {
            let file_name = format!("{}_{slug}_{suffix}.json", provider.as_str());
            let path = self.accounts_dir().join(&file_name);
            if create_json_without_overwrite(&path, &account)? {
                created_file = Some(file_name);
                break;
            }
        }
        let created_file = created_file.ok_or_else(|| {
            "storage: Không thể tạo tên file account không trùng lặp.".to_string()
        })?;

        if config
            .active_account_by_provider
            .get(provider.as_str())
            .is_none()
        {
            config
                .active_account_by_provider
                .insert(provider.as_str().into(), created_file.clone());
            rollback_created_account_on_error(
                &self.accounts_dir().join(&created_file),
                self.write_config(&config),
            )?;
        }

        self.list_unlocked(provider)
    }

    pub fn update(
        &self,
        provider: Provider,
        file_name: &str,
        label: &str,
        api_key: Option<&str>,
        base_url: &str,
    ) -> Result<ProviderAccountState, String> {
        let _guard = self.lock()?;
        self.ensure_layout()?;
        validate_account_file_name(file_name)?;
        let label = validate_label(label)?;
        let path = self.accounts_dir().join(file_name);
        let mut account = read_account_strict(&path, file_name, provider)?;
        account.label = label;
        if let Some(candidate) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
            account.api_key = validate_api_key(candidate)?;
        }
        account.base_url = Some(validate_base_url(provider, base_url)?);
        write_json_atomically(&path, &account)?;
        self.list_unlocked(provider)
    }

    pub fn set_active(
        &self,
        provider: Provider,
        file_name: &str,
    ) -> Result<ProviderAccountState, String> {
        let _guard = self.lock()?;
        self.ensure_layout()?;
        validate_account_file_name(file_name)?;
        let path = self.accounts_dir().join(file_name);
        read_account_strict(&path, file_name, provider)?;

        let mut config = self.read_config_for_mutation()?;
        config
            .active_account_by_provider
            .insert(provider.as_str().into(), file_name.into());
        self.write_config(&config)?;
        self.list_unlocked(provider)
    }

    pub fn delete(
        &self,
        provider: Provider,
        file_name: &str,
    ) -> Result<ProviderAccountState, String> {
        let _guard = self.lock()?;
        self.ensure_layout()?;
        validate_account_file_name(file_name)?;
        let path = self.accounts_dir().join(file_name);
        read_account_strict(&path, file_name, provider)?;
        let mut config = self.read_config_for_mutation()?;
        reject_symlink(&path, file_name)?;
        fs::remove_file(&path).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => format!("not_found: Không tìm thấy account {file_name}."),
            _ => "storage: Không thể xóa account trên máy này.".to_string(),
        })?;

        if config
            .active_account_by_provider
            .get(provider.as_str())
            .is_some_and(|active| active == file_name)
        {
            config.active_account_by_provider.remove(provider.as_str());
            self.write_config(&config)?;
        }
        self.list_unlocked(provider)
    }

    pub(crate) fn resolve_runtime_account(
        &self,
        provider: Provider,
        file_name: &str,
    ) -> Result<ProviderRuntimeAccount, String> {
        let _guard = self.lock()?;
        self.ensure_layout()?;
        validate_account_file_name(file_name)?;
        let path = self.accounts_dir().join(file_name);
        let account = read_account_strict(&path, file_name, provider)?;
        Ok(ProviderRuntimeAccount {
            api_key: account.api_key,
            base_url: account
                .base_url
                .unwrap_or_else(|| provider.default_base_url().into()),
        })
    }

    fn resolve_api_key(&self, provider: Provider, file_name: &str) -> Result<String, String> {
        Ok(self.resolve_runtime_account(provider, file_name)?.api_key)
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.mutation_lock
            .lock()
            .map_err(|_| "storage: Credential store đang ở trạng thái không hợp lệ.".to_string())
    }

    fn accounts_dir(&self) -> PathBuf {
        self.root.join("accounts")
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    fn ensure_layout(&self) -> Result<(), String> {
        ensure_private_directory(&self.root, ".whispersub")?;
        ensure_private_directory(&self.accounts_dir(), "accounts")?;
        let config_path = self.config_path();
        if !config_path.exists() {
            write_json_atomically(&config_path, &StoredConfig::default())?;
        } else {
            reject_symlink(&config_path, "config.json")?;
            set_private_file_permissions(&config_path)?;
        }
        Ok(())
    }

    fn read_config_lenient(&self) -> (StoredConfig, Option<String>) {
        let path = self.config_path();
        match read_json_file::<StoredConfig>(&path, "config.json") {
            Ok(config) if config.schema_version == SCHEMA_VERSION => (config, None),
            Ok(_) => (
                StoredConfig::default(),
                Some("Không đọc được config.json vì schema chưa được hỗ trợ.".into()),
            ),
            Err(error) => (StoredConfig::default(), Some(error)),
        }
    }

    fn read_config_for_mutation(&self) -> Result<StoredConfig, String> {
        let config = read_json_file::<StoredConfig>(&self.config_path(), "config.json")?;
        if config.schema_version != SCHEMA_VERSION {
            return Err(
                "storage: config.json dùng schema chưa được hỗ trợ; không có thay đổi nào được ghi."
                    .into(),
            );
        }
        Ok(config)
    }

    fn write_config(&self, config: &StoredConfig) -> Result<(), String> {
        write_json_atomically(&self.config_path(), config)
    }

    fn list_unlocked(&self, provider: Provider) -> Result<ProviderAccountState, String> {
        let (config, config_warning) = self.read_config_lenient();
        let mut warnings = config_warning.into_iter().collect::<Vec<_>>();
        let active_candidate = config
            .active_account_by_provider
            .get(provider.as_str())
            .cloned();
        let mut accounts = Vec::new();

        let entries = fs::read_dir(self.accounts_dir())
            .map_err(|_| "storage: Không thể đọc thư mục account.".to_string())?;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    warnings.push("Không thể đọc một entry trong thư mục account.".into());
                    continue;
                }
            };
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.ends_with(".json") || !is_valid_account_file_name(&file_name) {
                continue;
            }
            let path = entry.path();
            match read_account_unscoped(&path, &file_name) {
                Ok(account) if account.provider == provider => {
                    accounts.push(ProviderAccountSummary {
                        is_active: active_candidate.as_deref() == Some(file_name.as_str()),
                        file_name,
                        label: account.label,
                        provider,
                        base_url: account
                            .base_url
                            .unwrap_or_else(|| provider.default_base_url().into()),
                    })
                }
                Ok(_) => continue,
                Err(_) => {
                    warnings.push(format!("Không đọc được {file_name}; file đã được bỏ qua."))
                }
            }
        }

        accounts.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        let active_account_file = active_candidate.filter(|candidate| {
            accounts
                .iter()
                .any(|account| account.file_name == *candidate)
        });
        if config
            .active_account_by_provider
            .contains_key(provider.as_str())
            && active_account_file.is_none()
        {
            warnings.push(format!(
                "Account {} đang chọn không còn tồn tại.",
                provider.display_name()
            ));
        }
        for account in &mut accounts {
            account.is_active = active_account_file.as_deref() == Some(account.file_name.as_str());
        }

        Ok(ProviderAccountState {
            accounts,
            active_account_file,
            warnings,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProviderAccount {
    schema_version: u8,
    kind: String,
    provider: Provider,
    label: String,
    api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
}

impl StoredProviderAccount {
    fn new(provider: Provider, label: String, api_key: String, base_url: Option<String>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            kind: ACCOUNT_KIND.into(),
            provider,
            label,
            api_key,
            base_url,
        }
    }

    fn is_supported(&self) -> bool {
        self.schema_version == SCHEMA_VERSION
            && self.kind == ACCOUNT_KIND
            && validate_label(&self.label).is_ok()
            && validate_api_key(&self.api_key).is_ok()
            && self
                .base_url
                .as_deref()
                .is_none_or(|base_url| validate_base_url(self.provider, base_url).is_ok())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    schema_version: u8,
    active_account_by_provider: HashMap<String, String>,
}

impl Default for StoredConfig {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            active_account_by_provider: HashMap::new(),
        }
    }
}

fn validate_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    let length = label.chars().count();
    if length == 0 {
        return Err("validation: Hãy nhập tên hiển thị cho account.".into());
    }
    if length > MAX_LABEL_LENGTH {
        return Err(format!(
            "validation: Tên hiển thị không được dài hơn {MAX_LABEL_LENGTH} ký tự."
        ));
    }
    Ok(label.to_string())
}

fn validate_api_key(api_key: &str) -> Result<String, String> {
    let api_key = api_key.trim();
    if api_key.len() < MIN_API_KEY_LENGTH {
        return Err("validation: API key quá ngắn hoặc đang để trống.".into());
    }
    if api_key.len() > MAX_API_KEY_LENGTH {
        return Err(format!(
            "validation: API key không được dài hơn {MAX_API_KEY_LENGTH} ký tự."
        ));
    }
    if api_key.chars().any(char::is_control) {
        return Err("validation: API key chứa ký tự điều khiển không hợp lệ.".into());
    }
    Ok(api_key.to_string())
}

fn validate_base_url(provider: Provider, base_url: &str) -> Result<String, String> {
    let candidate = base_url.trim();
    let candidate = if candidate.is_empty() {
        provider.default_base_url()
    } else {
        candidate
    };
    if candidate.len() > MAX_BASE_URL_LENGTH {
        return Err(format!(
            "validation: Base URL không được dài hơn {MAX_BASE_URL_LENGTH} ký tự."
        ));
    }

    let parsed =
        Url::parse(candidate).map_err(|_| "validation: Base URL không hợp lệ.".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("validation: Base URL không được chứa thông tin đăng nhập.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("validation: Base URL không được chứa query hoặc fragment.".into());
    }

    let loopback = match parsed.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(
            "validation: Base URL phải dùng HTTPS. HTTP chỉ được phép cho endpoint loopback local."
                .into(),
        );
    }

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn build_provider_models_url(
    provider: Provider,
    base_url: &str,
    gemini_page_size: usize,
    page_token: Option<&str>,
) -> Result<Url, String> {
    let normalized = validate_base_url(provider, base_url)?;
    let mut url =
        Url::parse(&normalized).map_err(|_| "validation: Base URL không hợp lệ.".to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "validation: Base URL không hỗ trợ operation path.".to_string())?;
        segments.pop_if_empty();
        match provider {
            Provider::OpenAi => {
                segments.push("models");
            }
            Provider::Gemini => {
                segments.push("v1beta");
                segments.push("models");
            }
        }
    }
    if provider == Provider::Gemini {
        let mut query = url.query_pairs_mut();
        query.append_pair("pageSize", &gemini_page_size.to_string());
        if let Some(page_token) = page_token.filter(|value| !value.is_empty()) {
            query.append_pair("pageToken", page_token);
        }
    }
    Ok(url)
}

fn build_provider_probe_url(provider: Provider, base_url: &str) -> Result<Url, String> {
    build_provider_models_url(provider, base_url, 1, None)
}

fn classify_probe_status(status: u16) -> Result<ProviderConnectionTestResult, String> {
    match status {
        200..=299 => Ok(ProviderConnectionTestResult {
            outcome: ProviderConnectionOutcome::Connected,
            message: "Kết nối thành công. Provider đã chấp nhận API key.".into(),
        }),
        429 => Ok(ProviderConnectionTestResult {
            outcome: ProviderConnectionOutcome::RateLimited,
            message: "Provider đã phản hồi nhưng đang giới hạn tần suất hoặc quota. Chưa thể xác nhận chắc chắn API key.".into(),
        }),
        300..=399 => Err(
            "connection: Endpoint trả về chuyển hướng; WhisperSub đã chặn để tránh gửi API key sang host khác."
                .into(),
        ),
        400 => Err(
            "connection: Endpoint không chấp nhận probe. Hãy kiểm tra Base URL hoặc gateway."
                .into(),
        ),
        401 => Err("connection: API key không hợp lệ hoặc đã bị thu hồi.".into()),
        403 => Err("connection: API key không có quyền truy cập Models API.".into()),
        404 => Err(
            "connection: Không tìm thấy Models API. Hãy kiểm tra Base URL của provider."
                .into(),
        ),
        408 => Err("connection: Provider hết thời gian chờ phản hồi.".into()),
        500..=599 => Err(format!(
            "connection: Provider tạm thời không khả dụng (HTTP {status}). Hãy thử lại sau."
        )),
        _ => Err(format!(
            "connection: Provider từ chối probe (HTTP {status}). Hãy kiểm tra API key và Base URL."
        )),
    }
}

fn build_provider_probe_request(
    client: &Client,
    provider: Provider,
    api_key: &str,
    base_url: &str,
) -> Result<reqwest::Request, String> {
    let api_key = validate_api_key(api_key)?;
    let url = build_provider_probe_url(provider, base_url)?;
    let request = match provider {
        Provider::OpenAi => client.get(url).bearer_auth(api_key),
        Provider::Gemini => client.get(url).header("x-goog-api-key", api_key),
    };
    request
        .build()
        .map_err(|_| "connection: Không thể tạo provider probe an toàn.".to_string())
}

fn build_provider_models_request(
    client: &Client,
    provider: Provider,
    api_key: &str,
    base_url: &str,
    page_token: Option<&str>,
) -> Result<reqwest::Request, String> {
    let api_key = validate_api_key(api_key)?;
    let url = build_provider_models_url(provider, base_url, 1_000, page_token)?;
    let request = match provider {
        Provider::OpenAi => client.get(url).bearer_auth(api_key),
        Provider::Gemini => client.get(url).header("x-goog-api-key", api_key),
    };
    request
        .build()
        .map_err(|_| "models: Không thể tạo Models API request an toàn.".to_string())
}

fn validate_model_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_MODEL_ID_LENGTH
        || value.chars().any(char::is_control)
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn validate_model_display_name(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        if value.is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control) {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn validate_page_token(value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2_048 || value.chars().any(char::is_control) {
        Err("models: Gemini trả về page token không hợp lệ.".into())
    } else {
        Ok(value.to_string())
    }
}

fn parse_provider_model_page(provider: Provider, body: &[u8]) -> Result<ProviderModelPage, String> {
    match provider {
        Provider::OpenAi => {
            let response: OpenAiModelsResponse = serde_json::from_slice(body)
                .map_err(|_| "models: OpenAI trả về model catalog không hợp lệ.".to_string())?;
            Ok(ProviderModelPage {
                models: response
                    .data
                    .into_iter()
                    .filter_map(|model| {
                        validate_model_id(&model.id).map(|id| ProviderModelSummary {
                            id,
                            display_name: None,
                        })
                    })
                    .collect(),
                next_page_token: None,
            })
        }
        Provider::Gemini => {
            let response: GeminiModelsResponse = serde_json::from_slice(body)
                .map_err(|_| "models: Gemini trả về model catalog không hợp lệ.".to_string())?;
            let next_page_token = response
                .next_page_token
                .map(validate_page_token)
                .transpose()?;
            Ok(ProviderModelPage {
                models: response
                    .models
                    .into_iter()
                    .filter(|model| {
                        model
                            .supported_generation_methods
                            .iter()
                            .any(|method| method == "generateContent")
                    })
                    .filter_map(|model| {
                        let id = model.name.strip_prefix("models/").unwrap_or(&model.name);
                        validate_model_id(id).map(|id| ProviderModelSummary {
                            id,
                            display_name: validate_model_display_name(model.display_name),
                        })
                    })
                    .collect(),
                next_page_token,
            })
        }
    }
}

fn classify_model_catalog_status(status: u16, provider: Provider) -> Result<(), String> {
    let name = provider.display_name();
    match status {
        200..=299 => Ok(()),
        300..=399 => Err(
            "models: Endpoint chuyển hướng; WhisperSub đã chặn để tránh gửi API key sang host khác."
                .into(),
        ),
        401 => Err(format!(
            "models: {name} từ chối API key. Kiểm tra account đã chọn."
        )),
        403 => Err(format!(
            "models: {name} account không có quyền gọi Models API."
        )),
        404 => Err(format!(
            "models: Không tìm thấy Models API của {name}. Kiểm tra Base URL."
        )),
        408 => Err(format!("models: {name} hết thời gian chờ phản hồi.")),
        429 => Err(format!(
            "models: {name} đang giới hạn tần suất hoặc quota. Chờ rồi tải lại."
        )),
        500..=599 => Err(format!(
            "models: {name} tạm thời không khả dụng (HTTP {status}). Hãy thử lại sau."
        )),
        _ => Err(format!(
            "models: {name} từ chối Models API request (HTTP {status})."
        )),
    }
}

fn curate_provider_models(
    provider: Provider,
    mut models_by_id: HashMap<String, ProviderModelSummary>,
) -> Vec<ProviderModelSummary> {
    if provider == Provider::Gemini {
        return GEMINI_TRANSLATION_MODEL_IDS
            .iter()
            .filter_map(|id| models_by_id.remove(*id))
            .collect();
    }

    let mut models: Vec<_> = models_by_id.into_values().collect();
    models.sort_by(|left, right| left.id.to_lowercase().cmp(&right.id.to_lowercase()));
    models
}

async fn read_model_catalog_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MODEL_CATALOG_BYTES as u64)
    {
        return Err("models: Provider trả về model catalog quá lớn.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "models: Không thể đọc Models API response an toàn.".to_string())?
    {
        if body.len() + chunk.len() > MAX_MODEL_CATALOG_BYTES {
            return Err("models: Provider trả về model catalog quá lớn.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_provider_models(
    provider: Provider,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<ProviderModelSummary>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(MODEL_CATALOG_TIMEOUT_SECONDS))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "models: Không thể khởi tạo HTTP client an toàn.".to_string())?;
    let mut page_token: Option<String> = None;
    let mut seen_tokens = HashSet::new();
    let mut models_by_id = HashMap::new();

    for page_index in 0..MAX_MODEL_CATALOG_PAGES {
        let request = build_provider_models_request(
            &client,
            provider,
            api_key,
            base_url,
            page_token.as_deref(),
        )?;
        let response = client.execute(request).await.map_err(|error| {
            if error.is_timeout() {
                "models: Hết thời gian tải model sau 15 giây.".to_string()
            } else if error.is_connect() {
                "models: Không thể kết nối Models API. Kiểm tra mạng và Base URL.".to_string()
            } else {
                "models: Không thể hoàn tất Models API request an toàn.".to_string()
            }
        })?;
        classify_model_catalog_status(response.status().as_u16(), provider)?;
        let body = read_model_catalog_body(response).await?;
        let page = parse_provider_model_page(provider, &body)?;
        for model in page.models {
            models_by_id.entry(model.id.clone()).or_insert(model);
        }

        let Some(next_token) = page.next_page_token else {
            break;
        };
        if page_index + 1 >= MAX_MODEL_CATALOG_PAGES {
            return Err("models: Gemini model catalog vượt giới hạn phân trang an toàn.".into());
        }
        if !seen_tokens.insert(next_token.clone()) {
            return Err("models: Gemini trả về page token lặp lại.".into());
        }
        page_token = Some(next_token);
    }

    Ok(curate_provider_models(provider, models_by_id))
}

async fn probe_provider_connection(
    provider: Provider,
    api_key: &str,
    base_url: &str,
) -> Result<ProviderConnectionTestResult, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(CONNECTION_TIMEOUT_SECONDS))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "connection: Không thể khởi tạo HTTP client an toàn.".to_string())?;
    let request = build_provider_probe_request(&client, provider, api_key, base_url)?;
    let response = client.execute(request).await.map_err(|error| {
        if error.is_timeout() {
            "connection: Hết thời gian kiểm tra kết nối sau 10 giây.".to_string()
        } else if error.is_connect() {
            "connection: Không thể kết nối tới Base URL. Hãy kiểm tra mạng và endpoint.".to_string()
        } else {
            "connection: Không thể hoàn tất kiểm tra kết nối an toàn.".to_string()
        }
    })?;
    classify_probe_status(response.status().as_u16())
}

fn validate_account_file_name(file_name: &str) -> Result<(), String> {
    if is_valid_account_file_name(file_name) {
        Ok(())
    } else {
        Err("validation: Account filename không hợp lệ.".into())
    }
}

fn is_valid_account_file_name(file_name: &str) -> bool {
    let Some(stem) = file_name.strip_suffix(".json") else {
        return false;
    };
    !stem.is_empty()
        && !stem.starts_with('.')
        && stem.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn read_account_unscoped(path: &Path, file_name: &str) -> Result<StoredProviderAccount, String> {
    let account = read_json_file::<StoredProviderAccount>(path, file_name)?;
    if account.is_supported() {
        Ok(account)
    } else {
        Err(format!(
            "storage: {file_name} không phải provider account được hỗ trợ."
        ))
    }
}

fn read_account_strict(
    path: &Path,
    file_name: &str,
    provider: Provider,
) -> Result<StoredProviderAccount, String> {
    let account = read_account_unscoped(path, file_name)?;
    if account.provider == provider {
        Ok(account)
    } else {
        Err(format!(
            "validation: {file_name} không thuộc provider {}.",
            provider.display_name()
        ))
    }
}

fn read_json_file<T: for<'de> Deserialize<'de>>(
    path: &Path,
    display_name: &str,
) -> Result<T, String> {
    reject_symlink(path, display_name)?;
    let content = fs::read(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => format!("not_found: Không tìm thấy {display_name}."),
        _ => format!("storage: Không thể đọc {display_name}."),
    })?;
    serde_json::from_slice(&content)
        .map_err(|_| format!("storage: {display_name} không chứa JSON hợp lệ."))
}

fn ensure_private_directory(path: &Path, display_name: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "storage: {display_name} phải là thư mục local, không phải symlink hoặc file."
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path)
                .map_err(|_| format!("storage: Không thể tạo thư mục {display_name}."))?;
        }
        Err(_) => return Err(format!("storage: Không thể kiểm tra {display_name}.")),
    }
    set_private_directory_permissions(path)
}

fn reject_symlink(path: &Path, display_name: &str) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "storage: {display_name} không được phép là symlink."
            ));
        }
    }
    Ok(())
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    reject_symlink(
        path,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
    )?;
    let temp_path = write_json_temp(path, value)?;
    if fs::rename(&temp_path, path).is_err() {
        let _ = fs::remove_file(&temp_path);
        return Err("storage: Không thể hoàn tất việc ghi file local.".into());
    }
    set_private_file_permissions(path)
}

fn rollback_created_account_on_error(
    created_path: &Path,
    result: Result<(), String>,
) -> Result<(), String> {
    let Err(error) = result else {
        return Ok(());
    };
    match fs::remove_file(created_path) {
        Ok(()) => Err(error),
        Err(rollback_error) if rollback_error.kind() == io::ErrorKind::NotFound => Err(error),
        Err(_) => Err(format!(
            "{error} Không thể hoàn tác file account vừa tạo; hãy kiểm tra thư mục credential local."
        )),
    }
}

fn create_json_without_overwrite<T: Serialize>(path: &Path, value: &T) -> Result<bool, String> {
    let temp_path = write_json_temp(path, value)?;
    match fs::hard_link(&temp_path, path) {
        Ok(()) => {
            let _ = fs::remove_file(&temp_path);
            set_private_file_permissions(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&temp_path);
            Ok(false)
        }
        Err(_) => {
            let _ = fs::remove_file(&temp_path);
            Err("storage: Không thể tạo account file local.".into())
        }
    }
}

fn write_json_temp<T: Serialize>(target: &Path, value: &T) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "storage: File đích không có thư mục cha hợp lệ.".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("credential.json");
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(".{file_name}.{}.{counter}.tmp", std::process::id()));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temp_path)
        .map_err(|_| "storage: Không thể tạo file tạm an toàn.".to_string())?;
    if serde_json::to_writer_pretty(&mut file, value).is_err()
        || file.write_all(b"\n").is_err()
        || file.sync_all().is_err()
    {
        drop(file);
        let _ = fs::remove_file(&temp_path);
        return Err("storage: Không thể ghi JSON local.".into());
    }
    Ok(temp_path)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "storage: Không thể đặt quyền riêng tư cho thư mục.".to_string())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "storage: Không thể đặt quyền riêng tư cho file.".to_string())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn slugify_label(label: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in label.to_lowercase().chars() {
        let ascii = match character {
            'a'..='z' | '0'..='9' => Some(character),
            'à' | 'á' | 'ạ' | 'ả' | 'ã' | 'â' | 'ầ' | 'ấ' | 'ậ' | 'ẩ' | 'ẫ' | 'ă' | 'ằ' | 'ắ'
            | 'ặ' | 'ẳ' | 'ẵ' => Some('a'),
            'è' | 'é' | 'ẹ' | 'ẻ' | 'ẽ' | 'ê' | 'ề' | 'ế' | 'ệ' | 'ể' | 'ễ' => {
                Some('e')
            }
            'ì' | 'í' | 'ị' | 'ỉ' | 'ĩ' => Some('i'),
            'ò' | 'ó' | 'ọ' | 'ỏ' | 'õ' | 'ô' | 'ồ' | 'ố' | 'ộ' | 'ổ' | 'ỗ' | 'ơ' | 'ờ' | 'ớ'
            | 'ợ' | 'ở' | 'ỡ' => Some('o'),
            'ù' | 'ú' | 'ụ' | 'ủ' | 'ũ' | 'ư' | 'ừ' | 'ứ' | 'ự' | 'ử' | 'ữ' => {
                Some('u')
            }
            'ỳ' | 'ý' | 'ỵ' | 'ỷ' | 'ỹ' => Some('y'),
            'đ' => Some('d'),
            _ => None,
        };
        if let Some(ascii) = ascii {
            if pending_separator && !slug.is_empty() {
                slug.push('_');
            }
            slug.push(ascii);
            pending_separator = false;
        } else if !slug.is_empty() {
            pending_separator = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "account".into()
    } else {
        slug
    }
}

#[tauri::command]
pub fn list_provider_accounts(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
) -> Result<ProviderAccountState, String> {
    store.list(provider)
}

#[tauri::command]
pub async fn list_provider_models(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
    file_name: String,
) -> Result<Vec<ProviderModelSummary>, String> {
    let runtime = store.resolve_runtime_account(provider, &file_name)?;
    fetch_provider_models(provider, &runtime.api_key, &runtime.base_url).await
}

#[tauri::command]
pub fn create_provider_account(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
    label: String,
    api_key: String,
    base_url: String,
) -> Result<ProviderAccountState, String> {
    store.create(provider, &label, &api_key, &base_url)
}

#[tauri::command]
pub fn update_provider_account(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
    file_name: String,
    label: String,
    api_key: Option<String>,
    base_url: String,
) -> Result<ProviderAccountState, String> {
    store.update(provider, &file_name, &label, api_key.as_deref(), &base_url)
}

#[tauri::command]
pub fn set_active_provider_account(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
    file_name: String,
) -> Result<ProviderAccountState, String> {
    store.set_active(provider, &file_name)
}

#[tauri::command]
pub fn delete_provider_account(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
    file_name: String,
) -> Result<ProviderAccountState, String> {
    store.delete(provider, &file_name)
}

#[tauri::command]
pub async fn test_provider_connection(
    store: State<'_, ProviderAccountStore>,
    provider: Provider,
    api_key: Option<String>,
    base_url: String,
    file_name: Option<String>,
) -> Result<ProviderConnectionTestResult, String> {
    let typed_key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty());
    let api_key = match typed_key {
        Some(candidate) => validate_api_key(candidate)?,
        None => {
            let file_name = file_name
                .as_deref()
                .map(str::trim)
                .filter(|candidate| !candidate.is_empty())
                .ok_or_else(|| "validation: Hãy nhập API key trước khi kiểm tra.".to_string())?;
            store.resolve_api_key(provider, file_name)?
        }
    };

    probe_provider_connection(provider, &api_key, &base_url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("whispersub-{name}-{}-{nonce}", std::process::id()));
            Self(root)
        }

        fn store(&self) -> ProviderAccountStore {
            ProviderAccountStore::new(self.0.clone())
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn slugifies_vietnamese_labels_without_spaces() {
        assert_eq!(slugify_label("  Công ty Đỏ  "), "cong_ty_do");
        assert_eq!(slugify_label("Demo / Test"), "demo_test");
        assert_eq!(slugify_label("🗝️"), "account");
    }

    #[test]
    fn creates_provider_prefixed_collision_safe_files_and_redacts_secrets() {
        let root = TestRoot::new("create");
        let store = root.store();

        let first = store
            .create(Provider::OpenAi, "Công ty", "test-key-primary", "")
            .expect("first account should be created");
        let second = store
            .create(Provider::OpenAi, "Công ty", "test-key-secondary", "")
            .expect("second account should be created");

        let gemini = store
            .create(Provider::Gemini, "Công ty", "test-key-gemini", "")
            .expect("Gemini account should be created independently");

        assert_eq!(first.accounts[0].file_name, "openai_cong_ty_1.json");
        assert_eq!(second.accounts.len(), 2);
        assert_eq!(second.accounts[1].file_name, "openai_cong_ty_2.json");
        assert_eq!(gemini.accounts[0].file_name, "gemini_cong_ty_1.json");
        let response = serde_json::to_string(&second).expect("state should serialize");
        assert!(!response.contains("test-key"));
        assert!(root.0.join("accounts/openai_cong_ty_1.json").is_file());
        assert!(root.0.join("accounts/gemini_cong_ty_1.json").is_file());
        assert!(root.0.join("config.json").is_file());
    }

    #[test]
    fn rejects_mutations_on_unsupported_config_without_rewriting_it() {
        let root = TestRoot::new("unsupported-config");
        let store = root.store();
        store
            .create(Provider::OpenAi, "Work", "test-key-openai", "")
            .expect("OpenAI fixture should be created");

        let config_path = root.0.join("config.json");
        let unsupported_config = br#"{
  "schemaVersion": 2,
  "activeAccountByProvider": {
    "openai": "openai_work_1.json",
    "gemini": "gemini_personal_1.json"
  },
  "futureSetting": true
}
"#;
        fs::write(&config_path, unsupported_config)
            .expect("unsupported config fixture should be written");

        let select_error = store
            .set_active(Provider::OpenAi, "openai_work_1.json")
            .expect_err("selecting an account must reject unsupported config schemas");
        assert!(select_error.contains("schema"));
        assert_eq!(
            fs::read(&config_path).expect("config should remain readable"),
            unsupported_config
        );

        let create_error = store
            .create(Provider::Gemini, "New", "test-key-gemini", "")
            .expect_err("creating an account must reject unsupported config schemas");
        assert!(create_error.contains("schema"));
        assert!(!root.0.join("accounts/gemini_new_1.json").exists());
        assert_eq!(
            fs::read(&config_path).expect("config should remain unchanged"),
            unsupported_config
        );
    }

    #[test]
    fn removes_a_new_account_when_the_follow_up_config_write_fails() {
        let root = TestRoot::new("create-rollback");
        let store = root.store();
        store.ensure_layout().expect("layout should exist");
        let account_path = root.0.join("accounts/openai_work_1.json");
        create_json_without_overwrite(
            &account_path,
            &StoredProviderAccount::new(
                Provider::OpenAi,
                "Work".into(),
                "test-key-openai".into(),
                Some(Provider::OpenAi.default_base_url().into()),
            ),
        )
        .expect("account fixture should be created");

        let error = rollback_created_account_on_error(
            &account_path,
            Err("storage: Không thể ghi config.json.".into()),
        )
        .expect_err("the original config error should be returned");

        assert!(error.contains("Không thể ghi config.json"));
        assert!(!account_path.exists());
    }

    #[test]
    fn selects_updates_and_deletes_active_account() {
        let root = TestRoot::new("lifecycle");
        let store = root.store();
        store
            .create(Provider::OpenAi, "Cá nhân", "test-key-primary", "")
            .expect("account should be created");

        let selected = store
            .set_active(Provider::OpenAi, "openai_ca_nhan_1.json")
            .expect("account should become active");
        assert_eq!(
            selected.active_account_file.as_deref(),
            Some("openai_ca_nhan_1.json")
        );
        assert!(selected.accounts[0].is_active);

        let updated = store
            .update(
                Provider::OpenAi,
                "openai_ca_nhan_1.json",
                "API chính",
                None,
                "",
            )
            .expect("label should update");
        assert_eq!(updated.accounts[0].file_name, "openai_ca_nhan_1.json");
        assert_eq!(updated.accounts[0].label, "API chính");

        let deleted = store
            .delete(Provider::OpenAi, "openai_ca_nhan_1.json")
            .expect("account should be deleted");
        assert!(deleted.accounts.is_empty());
        assert_eq!(deleted.active_account_file, None);
    }

    #[test]
    fn rejects_invalid_labels_keys_and_paths() {
        let root = TestRoot::new("validation");
        let store = root.store();

        assert!(store
            .create(Provider::OpenAi, "   ", "test-key-primary", "")
            .is_err());
        assert!(store
            .create(Provider::Gemini, "Công ty", "short", "")
            .is_err());
        assert!(store
            .create(Provider::Gemini, "Công ty", "test-key\nleak", "")
            .is_err());
        assert!(store
            .set_active(Provider::OpenAi, "../config.json")
            .is_err());
        assert!(store.delete(Provider::Gemini, "/tmp/account.json").is_err());
    }

    #[test]
    fn skips_corrupt_account_files_with_a_warning() {
        let root = TestRoot::new("corrupt");
        let store = root.store();
        store
            .create(Provider::OpenAi, "Công ty", "test-key-primary", "")
            .expect("account should be created");
        fs::write(root.0.join("accounts/broken_1.json"), "not-json")
            .expect("fixture should be written");

        let state = store
            .list(Provider::OpenAi)
            .expect("valid accounts should still load");
        assert_eq!(state.accounts.len(), 1);
        assert_eq!(state.warnings.len(), 1);
        assert!(state.warnings[0].contains("broken_1.json"));
    }

    #[cfg(unix)]
    #[test]
    fn applies_private_directory_and_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestRoot::new("permissions");
        let store = root.store();
        store
            .create(Provider::OpenAi, "Công ty", "test-key-primary", "")
            .expect("account should be created");

        let root_mode = fs::metadata(&root.0)
            .expect("root metadata")
            .permissions()
            .mode()
            & 0o777;
        let accounts_mode = fs::metadata(root.0.join("accounts"))
            .expect("accounts metadata")
            .permissions()
            .mode()
            & 0o777;
        let account_mode = fs::metadata(root.0.join("accounts/openai_cong_ty_1.json"))
            .expect("account metadata")
            .permissions()
            .mode()
            & 0o777;
        let config_mode = fs::metadata(root.0.join("config.json"))
            .expect("config metadata")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(root_mode, 0o700);
        assert_eq!(accounts_mode, 0o700);
        assert_eq!(account_mode, 0o600);
        assert_eq!(config_mode, 0o600);
    }

    #[test]
    fn keeps_legacy_openai_filename_unchanged() {
        let root = TestRoot::new("legacy");
        let store = root.store();
        store.ensure_layout().expect("layout should exist");
        let legacy_path = root.0.join("accounts/cong_ty_1.json");
        write_json_atomically(
            &legacy_path,
            &StoredProviderAccount::new(
                Provider::OpenAi,
                "Công ty".into(),
                "test-key-legacy".into(),
                None,
            ),
        )
        .expect("legacy fixture should be written");

        let listed = store
            .list(Provider::OpenAi)
            .expect("legacy file should be listed");
        assert_eq!(listed.accounts[0].file_name, "cong_ty_1.json");
        store
            .update(Provider::OpenAi, "cong_ty_1.json", "Công ty mới", None, "")
            .expect("legacy file should update in place");
        store
            .set_active(Provider::OpenAi, "cong_ty_1.json")
            .expect("legacy file should be selectable");

        assert!(legacy_path.is_file());
        assert!(!root.0.join("accounts/openai_cong_ty_1.json").exists());
    }

    #[test]
    fn rejects_cross_provider_mutations_and_keeps_active_pointers_independent() {
        let root = TestRoot::new("providers");
        let store = root.store();
        store
            .create(Provider::OpenAi, "Work", "test-key-openai", "")
            .expect("OpenAI account should be created");
        store
            .create(Provider::Gemini, "Work", "test-key-gemini", "")
            .expect("Gemini account should be created");

        assert!(store
            .update(
                Provider::OpenAi,
                "gemini_work_1.json",
                "Wrong provider",
                None,
                "",
            )
            .is_err());
        let openai = store
            .list(Provider::OpenAi)
            .expect("OpenAI list should load");
        let gemini = store
            .list(Provider::Gemini)
            .expect("Gemini list should load");
        assert_eq!(
            openai.active_account_file.as_deref(),
            Some("openai_work_1.json")
        );
        assert_eq!(
            gemini.active_account_file.as_deref(),
            Some("gemini_work_1.json")
        );
    }

    #[test]
    fn resolves_defaults_normalizes_overrides_and_redacts_secrets() {
        let root = TestRoot::new("base-url");
        let store = root.store();

        let openai = store
            .create(Provider::OpenAi, "Default", "test-key-openai", "")
            .expect("blank OpenAI URL should use the official default");
        let gemini = store
            .create(
                Provider::Gemini,
                "Gateway",
                "test-key-gemini",
                " https://gateway.example/gemini/// ",
            )
            .expect("HTTPS gateway should be normalized");

        assert_eq!(openai.accounts[0].base_url, "https://api.openai.com/v1");
        assert_eq!(
            gemini.accounts[0].base_url,
            "https://gateway.example/gemini"
        );
        let response = serde_json::to_string(&gemini).expect("state should serialize");
        assert!(!response.contains("test-key-gemini"));

        let reset = store
            .update(
                Provider::Gemini,
                "gemini_gateway_1.json",
                "Gateway",
                None,
                "",
            )
            .expect("blank update should restore the provider default");
        assert_eq!(
            reset.accounts[0].base_url,
            "https://generativelanguage.googleapis.com"
        );
    }

    #[test]
    fn reads_legacy_account_without_base_url_without_rewriting_it() {
        let root = TestRoot::new("legacy-base-url");
        let store = root.store();
        store.ensure_layout().expect("layout should exist");
        let path = root.0.join("accounts/legacy_1.json");
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "kind": "provider_account",
  "provider": "gemini",
  "label": "Legacy",
  "apiKey": "test-key-legacy"
}
"#,
        )
        .expect("legacy fixture should be written");
        let before = fs::read(&path).expect("legacy fixture should be readable");

        let state = store
            .list(Provider::Gemini)
            .expect("legacy account should remain readable");

        assert_eq!(
            state.accounts[0].base_url,
            "https://generativelanguage.googleapis.com"
        );
        assert_eq!(
            fs::read(&path).expect("list must not rewrite the legacy file"),
            before
        );
    }

    #[test]
    fn rejects_remote_http_userinfo_query_and_fragment_but_allows_loopback_http() {
        let root = TestRoot::new("base-url-validation");
        let store = root.store();

        for candidate in [
            "http://gateway.example/v1",
            "https://user@gateway.example/v1",
            "https://gateway.example/v1?tenant=1",
            "https://gateway.example/v1#anchor",
        ] {
            assert!(store
                .create(Provider::OpenAi, "Invalid", "test-key-openai", candidate)
                .is_err());
        }

        let state = store
            .create(
                Provider::OpenAi,
                "Local proxy",
                "test-key-openai",
                "http://localhost:8787/",
            )
            .expect("loopback HTTP should be allowed for local development");
        assert_eq!(state.accounts[0].base_url, "http://localhost:8787");
    }

    #[test]
    fn builds_provider_specific_probe_urls_without_putting_the_key_in_the_url() {
        let openai = build_provider_probe_url(Provider::OpenAi, "https://api.openai.com/v1")
            .expect("OpenAI probe URL should build");
        let gemini = build_provider_probe_url(
            Provider::Gemini,
            "https://generativelanguage.googleapis.com",
        )
        .expect("Gemini probe URL should build");

        assert_eq!(openai.as_str(), "https://api.openai.com/v1/models");
        assert_eq!(
            gemini.as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
        );
        assert!(!openai.as_str().contains("test-key"));
        assert!(!gemini.as_str().contains("test-key"));
    }

    #[test]
    fn classifies_probe_statuses_without_returning_provider_response_bodies() {
        let connected = classify_probe_status(200).expect("2xx should connect");
        let limited = classify_probe_status(429).expect("429 should be a warning result");

        assert_eq!(connected.outcome, ProviderConnectionOutcome::Connected);
        assert_eq!(limited.outcome, ProviderConnectionOutcome::RateLimited);
        assert!(classify_probe_status(401).unwrap_err().contains("API key"));
        assert!(classify_probe_status(300)
            .unwrap_err()
            .contains("chuyển hướng"));
        assert!(classify_probe_status(302)
            .unwrap_err()
            .contains("chuyển hướng"));
        assert!(classify_probe_status(503).unwrap_err().contains("tạm thời"));
    }

    #[test]
    fn resolves_an_existing_account_key_for_edit_probe_without_serializing_it() {
        let root = TestRoot::new("probe-existing");
        let store = root.store();
        store
            .create(Provider::Gemini, "Existing", "test-key-existing", "")
            .expect("fixture account should be created");

        let key = store
            .resolve_api_key(Provider::Gemini, "gemini_existing_1.json")
            .expect("stored key should resolve inside Rust");

        assert_eq!(key, "test-key-existing");
        assert!(
            !serde_json::to_string(&store.list(Provider::Gemini).unwrap())
                .unwrap()
                .contains(&key)
        );
    }

    #[test]
    fn builds_provider_headers_without_putting_keys_in_request_urls() {
        let client = Client::new();
        let gemini = build_provider_probe_request(
            &client,
            Provider::Gemini,
            "test-key-gemini",
            "https://generativelanguage.googleapis.com",
        )
        .expect("Gemini request should build");
        let openai = build_provider_probe_request(
            &client,
            Provider::OpenAi,
            "test-key-openai",
            "https://api.openai.com/v1",
        )
        .expect("OpenAI request should build");

        assert_eq!(gemini.url().path(), "/v1beta/models");
        assert_eq!(gemini.url().query(), Some("pageSize=1"));
        assert_eq!(
            gemini.headers().get("x-goog-api-key").unwrap(),
            "test-key-gemini"
        );
        assert_eq!(openai.url().path(), "/v1/models");
        assert_eq!(
            openai.headers().get("authorization").unwrap(),
            "Bearer test-key-openai"
        );
        assert!(!gemini.url().as_str().contains("test-key"));
        assert!(!openai.url().as_str().contains("test-key"));
    }

    #[test]
    fn parses_openai_and_filters_gemini_generation_model_catalogs() {
        let openai = parse_provider_model_page(
            Provider::OpenAi,
            br#"{"data":[{"id":"gpt-5.6-terra"},{"id":"gpt-5.6-luna"}]}"#,
        )
        .expect("OpenAI catalog should parse");
        let gemini = parse_provider_model_page(
            Provider::Gemini,
            br#"{
                "models":[
                    {"name":"models/gemini-3.5-flash","displayName":"Gemini 3.5 Flash","supportedGenerationMethods":["generateContent","countTokens"]},
                    {"name":"models/embedding-001","displayName":"Embedding","supportedGenerationMethods":["embedContent"]}
                ],
                "nextPageToken":"next-safe-token"
            }"#,
        )
        .expect("Gemini catalog should parse");

        assert_eq!(
            openai
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.6-terra", "gpt-5.6-luna"]
        );
        assert_eq!(gemini.models.len(), 1);
        assert_eq!(gemini.models[0].id, "gemini-3.5-flash");
        assert_eq!(
            gemini.models[0].display_name.as_deref(),
            Some("Gemini 3.5 Flash")
        );
        assert_eq!(gemini.next_page_token.as_deref(), Some("next-safe-token"));
    }

    #[test]
    fn curates_gemini_translation_models_without_retaining_the_full_catalog() {
        let models = [
            ProviderModelSummary {
                id: "gemini-3.5-flash".into(),
                display_name: Some("Gemini 3.5 Flash".into()),
            },
            ProviderModelSummary {
                id: "gemini-3.1-pro-preview".into(),
                display_name: Some("Gemini 3.1 Pro Preview".into()),
            },
            ProviderModelSummary {
                id: "gemini-3.1-flash-lite".into(),
                display_name: Some("Gemini 3.1 Flash Lite".into()),
            },
            ProviderModelSummary {
                id: "gemini-3.1-flash-tts-preview".into(),
                display_name: Some("Gemini 3.1 Flash TTS Preview".into()),
            },
        ]
        .into_iter()
        .map(|model| (model.id.clone(), model))
        .collect();

        let curated = curate_provider_models(Provider::Gemini, models);

        assert_eq!(
            curated
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gemini-3.1-flash-lite", "gemini-3.5-flash"]
        );
    }

    #[test]
    fn builds_catalog_pagination_and_auth_without_putting_keys_in_urls() {
        let client = Client::new();
        let gemini = build_provider_models_request(
            &client,
            Provider::Gemini,
            "test-key-gemini",
            "https://generativelanguage.googleapis.com",
            Some("next token"),
        )
        .expect("Gemini model request should build");
        let openai = build_provider_models_request(
            &client,
            Provider::OpenAi,
            "test-key-openai",
            "https://api.openai.com/v1",
            None,
        )
        .expect("OpenAI model request should build");

        assert_eq!(
            gemini.url().as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=next+token"
        );
        assert_eq!(
            gemini.headers().get("x-goog-api-key").unwrap(),
            "test-key-gemini"
        );
        assert_eq!(openai.url().as_str(), "https://api.openai.com/v1/models");
        assert_eq!(
            openai.headers().get("authorization").unwrap(),
            "Bearer test-key-openai"
        );
        assert!(!gemini.url().as_str().contains("test-key"));
        assert!(!openai.url().as_str().contains("test-key"));
    }
}
