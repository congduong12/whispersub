use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

const SETTINGS_SCHEMA_VERSION: u8 = 1;
const OUTPUT_DIRECTORY_COMPONENTS: [&str; 2] = ["WhisperSub", "Subtitles"];
const YOUTUBE_CACHE_DIRECTORY_NAME: &str = "youtube-cache";
const YOUTUBE_LIBRARY_DIRECTORY_NAME: &str = "youtube-library";
const SETTINGS_FILE_NAME: &str = "storage-settings.json";

#[derive(Debug)]
pub struct LocalStorage {
    documents_dir: PathBuf,
    app_data_dir: PathBuf,
    guard: Mutex<()>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageInfo {
    output_directory: String,
    default_output_directory: String,
    uses_custom_output_directory: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageSettings {
    schema_version: u8,
    selected_output_directory: Option<String>,
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            selected_output_directory: None,
        }
    }
}

impl LocalStorage {
    pub fn new(documents_dir: PathBuf, app_data_dir: PathBuf) -> Self {
        Self {
            documents_dir,
            app_data_dir,
            guard: Mutex::new(()),
        }
    }

    pub fn youtube_cache_directory(&self) -> Result<PathBuf, String> {
        let _guard = self
            .guard
            .lock()
            .map_err(|_| "local storage lock poisoned".to_string())?;
        let directory = self.youtube_cache_path();
        ensure_directory(&directory, "YouTube cache")?;
        set_private_directory_permissions(&directory)?;
        Ok(directory)
    }

    pub fn youtube_library_directory(&self) -> Result<PathBuf, String> {
        let _guard = self
            .guard
            .lock()
            .map_err(|_| "local storage lock poisoned".to_string())?;
        let directory = self.app_data_dir.join(YOUTUBE_LIBRARY_DIRECTORY_NAME);
        ensure_directory(&directory, "YouTube library")?;
        set_private_directory_permissions(&directory)?;
        Ok(directory)
    }

    fn info(&self) -> Result<LocalStorageInfo, String> {
        let _guard = self
            .guard
            .lock()
            .map_err(|_| "local storage lock poisoned".to_string())?;
        self.info_locked()
    }

    fn remember_output_directory(&self, directory: &Path) -> Result<LocalStorageInfo, String> {
        if !directory.is_absolute() {
            return Err("output directory must be absolute".into());
        }
        if !directory.is_dir() {
            return Err("selected output directory does not exist".into());
        }

        let _guard = self
            .guard
            .lock()
            .map_err(|_| "local storage lock poisoned".to_string())?;
        ensure_directory(&self.app_data_dir, "Application Support")?;
        let selected = path_to_string(directory)?;
        write_settings_atomic(
            &self.settings_path(),
            &StorageSettings {
                schema_version: SETTINGS_SCHEMA_VERSION,
                selected_output_directory: Some(selected),
            },
        )?;
        self.info_locked()
    }

    fn info_locked(&self) -> Result<LocalStorageInfo, String> {
        let default_output = self.default_output_path();
        let cache = self.youtube_cache_path();
        ensure_directory(&default_output, "default subtitle output")?;
        ensure_directory(&cache, "YouTube cache")?;
        set_private_directory_permissions(&cache)?;

        let settings = read_settings(&self.settings_path())?;
        let selected = settings
            .selected_output_directory
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_output.clone());
        if !selected.is_absolute() {
            return Err("remembered output directory is not absolute".into());
        }

        Ok(LocalStorageInfo {
            output_directory: path_to_string(&selected)?,
            default_output_directory: path_to_string(&default_output)?,
            uses_custom_output_directory: selected != default_output,
        })
    }

    fn default_output_path(&self) -> PathBuf {
        OUTPUT_DIRECTORY_COMPONENTS
            .iter()
            .fold(self.documents_dir.clone(), |path, component| {
                path.join(component)
            })
    }

    fn youtube_cache_path(&self) -> PathBuf {
        self.app_data_dir.join(YOUTUBE_CACHE_DIRECTORY_NAME)
    }

    fn settings_path(&self) -> PathBuf {
        self.app_data_dir.join(SETTINGS_FILE_NAME)
    }
}

#[tauri::command]
pub fn get_local_storage_info(
    storage: State<'_, LocalStorage>,
) -> Result<LocalStorageInfo, String> {
    storage.info()
}

#[tauri::command]
pub fn remember_output_directory(
    storage: State<'_, LocalStorage>,
    directory: String,
) -> Result<LocalStorageInfo, String> {
    storage.remember_output_directory(Path::new(&directory))
}

fn read_settings(path: &Path) -> Result<StorageSettings, String> {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StorageSettings::default())
        }
        Err(error) => return Err(format!("failed to read storage settings: {error}")),
    };
    let settings: StorageSettings = serde_json::from_slice(&content)
        .map_err(|error| format!("storage settings are invalid: {error}"))?;
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(format!(
            "unsupported storage settings schema: {}",
            settings.schema_version
        ));
    }
    Ok(settings)
}

fn write_settings_atomic(path: &Path, settings: &StorageSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "storage settings path has no parent".to_string())?;
    ensure_directory(parent, "Application Support")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_path = parent.join(format!(
        ".{SETTINGS_FILE_NAME}.{}.{nonce}.tmp",
        std::process::id()
    ));
    let payload = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("failed to encode storage settings: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("failed to create storage settings: {error}"))?;
    let publish_result = (|| {
        file.write_all(&payload)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("failed to write storage settings: {error}"))?;
        set_private_file_permissions(&temporary_path)?;
        fs::rename(&temporary_path, path)
            .map_err(|error| format!("failed to publish storage settings: {error}"))
    })();
    if publish_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    publish_result
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create {label} directory: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} path is not a directory"));
    }
    Ok(())
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "storage path is not valid UTF-8".to_string())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("failed to protect storage settings: {error}"))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to protect local cache directory: {error}"))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::LocalStorage;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture() -> (std::path::PathBuf, LocalStorage) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "whispersub-local-storage-{}-{nonce}",
            std::process::id()
        ));
        let storage = LocalStorage::new(root.join("Documents"), root.join("Application Support"));
        (root, storage)
    }

    #[test]
    fn creates_system_relative_default_output_and_cache_directories() {
        let (root, storage) = fixture();

        let info = storage.info().expect("storage should initialize");

        assert_eq!(
            info.output_directory,
            root.join("Documents/WhisperSub/Subtitles")
                .to_string_lossy()
        );
        assert!(root.join("Documents/WhisperSub/Subtitles").is_dir());
        assert!(root.join("Application Support/youtube-cache").is_dir());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn persists_a_selected_output_directory() {
        let (root, storage) = fixture();
        let selected = root.join("Exports");
        fs::create_dir_all(&selected).expect("selected directory should exist");

        storage
            .remember_output_directory(&selected)
            .expect("selection should be persisted");
        let restarted = LocalStorage::new(root.join("Documents"), root.join("Application Support"));
        let info = restarted.info().expect("settings should be loaded");

        assert_eq!(info.output_directory, selected.to_string_lossy());
        assert!(info.uses_custom_output_directory);
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn protects_cache_and_settings_from_other_local_users() {
        use std::os::unix::fs::PermissionsExt;

        let (root, storage) = fixture();
        let selected = root.join("Exports");
        fs::create_dir_all(&selected).expect("selected directory should exist");
        storage.info().expect("storage should initialize");
        storage
            .remember_output_directory(&selected)
            .expect("settings should be written");

        let cache_mode = fs::metadata(root.join("Application Support/youtube-cache"))
            .expect("cache metadata should exist")
            .permissions()
            .mode()
            & 0o777;
        let settings_mode = fs::metadata(root.join("Application Support/storage-settings.json"))
            .expect("settings metadata should exist")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(cache_mode, 0o700);
        assert_eq!(settings_mode, 0o600);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn fails_closed_when_settings_are_corrupt() {
        let (root, storage) = fixture();
        fs::create_dir_all(root.join("Application Support"))
            .expect("app data directory should exist");
        fs::write(
            root.join("Application Support/storage-settings.json"),
            b"{not-json",
        )
        .expect("corrupt fixture should be written");

        let error = storage
            .info()
            .expect_err("corrupt settings must be visible");

        assert!(error.contains("storage settings are invalid"));
        fs::remove_dir_all(root).ok();
    }
}
