use crate::openai_accounts::{Provider, ProviderAccountStore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const JOB_EVENT_NAME: &str = "whispersub://job-event";

type WorkerHandle = Arc<Mutex<Child>>;

enum WorkerLifecycle<T> {
    Idle,
    Starting {
        job_id: String,
        worker: Option<T>,
        cancel_requested: bool,
    },
    Running {
        job_id: String,
        worker: T,
        cancel_requested: bool,
    },
}

impl<T> Default for WorkerLifecycle<T> {
    fn default() -> Self {
        Self::Idle
    }
}

impl<T> WorkerLifecycle<T> {
    fn reserve_start(&mut self, job_id: &str) -> Result<(), String> {
        if !matches!(self, Self::Idle) {
            return Err("another transcription job is already active".into());
        }
        *self = Self::Starting {
            job_id: job_id.into(),
            worker: None,
            cancel_requested: false,
        };
        Ok(())
    }

    fn register_starting_worker(&mut self, job_id: &str, new_worker: T) -> Result<bool, String> {
        match self {
            Self::Starting {
                job_id: active_job_id,
                worker,
                cancel_requested,
            } if active_job_id == job_id => {
                if worker.is_some() {
                    return Err("worker is already registered for this start".into());
                }
                *worker = Some(new_worker);
                Ok(*cancel_requested)
            }
            _ => Err("worker start reservation is no longer active".into()),
        }
    }

    fn commit_start(&mut self, job_id: &str) -> Result<bool, String> {
        match self {
            Self::Starting {
                job_id: active_job_id,
                worker,
                cancel_requested,
            } if active_job_id == job_id => {
                let cancel_requested = *cancel_requested;
                let worker = worker
                    .take()
                    .ok_or_else(|| "worker has not been registered for this start".to_string())?;
                *self = Self::Running {
                    job_id: job_id.into(),
                    worker,
                    cancel_requested,
                };
                Ok(cancel_requested)
            }
            _ => Err("worker start reservation is no longer active".into()),
        }
    }

    fn rollback_start(&mut self, job_id: &str) {
        if matches!(self, Self::Starting { job_id: active_job_id, .. } if active_job_id == job_id) {
            *self = Self::Idle;
        }
    }

    fn request_cancel(&mut self, job_id: &str) -> Option<&T> {
        match self {
            Self::Starting {
                job_id: active_job_id,
                worker,
                cancel_requested,
            } if active_job_id == job_id => {
                *cancel_requested = true;
                worker.as_ref()
            }
            Self::Running {
                job_id: active_job_id,
                worker,
                cancel_requested,
            } if active_job_id == job_id => {
                *cancel_requested = true;
                Some(worker)
            }
            _ => None,
        }
    }

    fn finish(&mut self, job_id: &str) -> Option<bool> {
        let cancelled = match self {
            Self::Running {
                job_id: active_job_id,
                cancel_requested,
                ..
            } if active_job_id == job_id => Some(*cancel_requested),
            _ => None,
        };
        if cancelled.is_some() {
            *self = Self::Idle;
        }
        cancelled
    }
}

#[derive(Default)]
pub struct JobRuntime {
    lifecycle: Mutex<WorkerLifecycle<WorkerHandle>>,
}

impl JobRuntime {
    fn reserve_start(&self, job_id: &str) -> Result<StartReservation<'_>, String> {
        self.lifecycle
            .lock()
            .map_err(|_| "job runtime lock poisoned")?
            .reserve_start(job_id)?;
        Ok(StartReservation {
            runtime: self,
            job_id: job_id.into(),
            committed: false,
        })
    }

    fn request_cancel(&self, job_id: &str) -> Result<Option<WorkerHandle>, String> {
        Ok(self
            .lifecycle
            .lock()
            .map_err(|_| "job runtime lock poisoned")?
            .request_cancel(job_id)
            .cloned())
    }

    fn finish(&self, job_id: &str) -> Result<bool, String> {
        Ok(self
            .lifecycle
            .lock()
            .map_err(|_| "job runtime lock poisoned")?
            .finish(job_id)
            .unwrap_or(false))
    }
}

struct StartReservation<'a> {
    runtime: &'a JobRuntime,
    job_id: String,
    committed: bool,
}

impl StartReservation<'_> {
    fn register_worker(&self, worker: WorkerHandle) -> Result<bool, String> {
        self.runtime
            .lifecycle
            .lock()
            .map_err(|_| "job runtime lock poisoned")?
            .register_starting_worker(&self.job_id, worker)
    }

    fn cancel_requested(&self) -> Result<bool, String> {
        let lifecycle = self
            .runtime
            .lifecycle
            .lock()
            .map_err(|_| "job runtime lock poisoned")?;
        match &*lifecycle {
            WorkerLifecycle::Starting {
                job_id,
                cancel_requested,
                ..
            } if job_id == &self.job_id => Ok(*cancel_requested),
            _ => Err("worker start reservation is no longer active".into()),
        }
    }

    fn commit(mut self) -> Result<bool, String> {
        let cancel_requested = self
            .runtime
            .lifecycle
            .lock()
            .map_err(|_| "job runtime lock poisoned")?
            .commit_start(&self.job_id)?;
        self.committed = true;
        Ok(cancel_requested)
    }
}

impl Drop for StartReservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut lifecycle) = self.runtime.lifecycle.lock() {
                lifecycle.rollback_start(&self.job_id);
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateOutputLocationsRequest {
    input_paths: Vec<String>,
    output_location_mode: String,
    output_directory: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLocationValidationResult {
    valid: bool,
    code: Option<String>,
    path: Option<String>,
}

impl OutputLocationValidationResult {
    fn valid() -> Self {
        Self {
            valid: true,
            code: None,
            path: None,
        }
    }

    fn invalid(code: &str, path: Option<&Path>) -> Self {
        Self {
            valid: false,
            code: Some(code.into()),
            path: path.map(|value| value.to_string_lossy().into_owned()),
        }
    }
}

#[tauri::command]
pub async fn validate_output_locations(
    request: ValidateOutputLocationsRequest,
) -> Result<OutputLocationValidationResult, String> {
    tauri::async_runtime::spawn_blocking(move || validate_output_locations_blocking(request))
        .await
        .map_err(|error| format!("failed to validate output locations: {error}"))
}

fn validate_output_locations_blocking(
    request: ValidateOutputLocationsRequest,
) -> OutputLocationValidationResult {
    if request.input_paths.is_empty() {
        return OutputLocationValidationResult::invalid("NO_INPUTS", None);
    }

    let mut input_directories = HashSet::new();
    for input_path in &request.input_paths {
        let input = Path::new(input_path);
        if !input.is_file() {
            return OutputLocationValidationResult::invalid("INPUT_NOT_FOUND", Some(input));
        }
        let Some(parent) = input.parent() else {
            return OutputLocationValidationResult::invalid("INPUT_NOT_FOUND", Some(input));
        };
        input_directories.insert(parent.to_path_buf());
    }

    let directories = match request.output_location_mode.as_str() {
        "same_as_input" => input_directories,
        "custom_directory" => {
            let Some(output_directory) = request
                .output_directory
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
            else {
                return OutputLocationValidationResult::invalid("DIRECTORY_REQUIRED", None);
            };
            if !output_directory.is_absolute() {
                return OutputLocationValidationResult::invalid(
                    "DIRECTORY_NOT_ABSOLUTE",
                    Some(&output_directory),
                );
            }
            HashSet::from([output_directory])
        }
        _ => return OutputLocationValidationResult::invalid("INVALID_MODE", None),
    };

    for directory in directories {
        if !directory.is_dir() {
            return OutputLocationValidationResult::invalid(
                "DIRECTORY_NOT_FOUND",
                Some(&directory),
            );
        }
        if !directory_accepts_probe_file(&directory) {
            return OutputLocationValidationResult::invalid(
                "DIRECTORY_NOT_WRITABLE",
                Some(&directory),
            );
        }
    }

    OutputLocationValidationResult::valid()
}

fn directory_accepts_probe_file(directory: &Path) -> bool {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    for attempt in 0..4 {
        let probe_path = directory.join(format!(
            ".whispersub-write-probe-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe_path)
        {
            Ok(file) => {
                drop(file);
                return fs::remove_file(probe_path).is_ok();
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return false,
        }
    }

    false
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobRequest {
    #[serde(rename = "type")]
    request_type: String,
    job_id: String,
    input_path: String,
    output_location_mode: String,
    output_directory: Option<String>,
    model: String,
    source_language: String,
    target_language: String,
    task: String,
    translation_provider: String,
    translation_mode: String,
    technical_translation: bool,
    glossary: Option<String>,
    #[serde(skip_serializing)]
    provider_account_file: Option<String>,
    provider_model: Option<String>,
    translation_consent: bool,
    device: String,
    output_formats: Vec<String>,
    overwrite_policy: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerStartJobRequest {
    #[serde(flatten)]
    request: StartJobRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_base_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHealth {
    status: &'static str,
    worker: &'static str,
    protocol_version: u8,
}

#[tauri::command]
pub fn health_check() -> WorkerHealth {
    WorkerHealth {
        status: "ok",
        worker: "python-jsonl",
        protocol_version: 1,
    }
}

#[tauri::command]
pub async fn start_transcription_job(
    app: AppHandle,
    state: State<'_, JobRuntime>,
    account_store: State<'_, ProviderAccountStore>,
    request: StartJobRequest,
) -> Result<(), String> {
    validate_request(&request)?;
    let reservation = state.reserve_start(&request.job_id)?;
    let worker_request = build_worker_request(&request, &account_store)?;

    let request_line = serde_json::to_string(&worker_request).map_err(|error| error.to_string())?;
    let (child, stdout, stderr) = spawn_worker(&request)?;
    let child = Arc::new(Mutex::new(child));
    let cancelled_before_delivery = match reservation.register_worker(Arc::clone(&child)) {
        Ok(cancel_requested) => cancel_requested,
        Err(error) => {
            terminate_worker(&child);
            return Err(error);
        }
    };
    let mut stdin = {
        let mut process = child.lock().map_err(|_| "worker process lock poisoned")?;
        match process.stdin.take() {
            Some(stdin) => stdin,
            None => {
                terminate_child(&mut process);
                return Err("worker stdin was not piped".into());
            }
        }
    };
    let write_result = if cancelled_before_delivery {
        Ok(())
    } else {
        stdin
            .write_all(format!("{request_line}\n").as_bytes())
            .map_err(|error| format!("failed to write worker request: {error}"))
    };
    drop(stdin);
    if let Err(error) = write_result {
        if !reservation.cancel_requested()? {
            terminate_worker(&child);
            return Err(error);
        }
    }

    let cancel_requested = match reservation.commit() {
        Ok(cancel_requested) => cancel_requested,
        Err(error) => {
            terminate_worker(&child);
            return Err(error);
        }
    };
    let job_id = request.job_id.clone();
    thread::spawn(move || forward_stderr(stderr, job_id));
    let bridge_child = Arc::clone(&child);
    tauri::async_runtime::spawn_blocking(move || {
        bridge_worker_events(app, request.job_id, bridge_child, stdout)
    });
    if cancel_requested {
        let mut process = child.lock().map_err(|_| "worker process lock poisoned")?;
        kill_child(&mut process)?;
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_transcription_job(
    state: State<'_, JobRuntime>,
    job_id: String,
) -> Result<(), String> {
    let worker = state.request_cancel(&job_id)?;
    if let Some(worker) = worker {
        let mut child = worker.lock().map_err(|_| "worker process lock poisoned")?;
        kill_child(&mut child)?;
    }
    Ok(())
}

fn kill_child(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| format!("failed to cancel worker: {error}"))?;
    }
    Ok(())
}

fn terminate_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn terminate_worker(worker: &WorkerHandle) {
    if let Ok(mut child) = worker.lock() {
        terminate_child(&mut child);
    }
}

fn validate_request(request: &StartJobRequest) -> Result<(), String> {
    if request.request_type != "start_job" {
        return Err("request type must be start_job".into());
    }
    if request.job_id.trim().is_empty() {
        return Err("jobId must not be empty".into());
    }
    validate_translation_selection(request)?;
    let input = Path::new(&request.input_path);
    if !input.is_file() {
        return Err(format!(
            "inputPath is not a readable file: {}",
            request.input_path
        ));
    }
    if request.task != "transcribe" {
        return Err("task must be transcribe".into());
    }
    if !request.output_formats.iter().any(|value| value == "srt") {
        return Err("SRT output is required".into());
    }
    if request.output_location_mode == "custom_directory" {
        let output = request
            .output_directory
            .as_deref()
            .map(Path::new)
            .ok_or_else(|| "outputDirectory is required".to_string())?;
        if !output.is_dir() {
            return Err("outputDirectory must be an existing directory".into());
        }
    }
    Ok(())
}

fn validate_translation_selection(request: &StartJobRequest) -> Result<(), String> {
    match request.translation_provider.as_str() {
        "none" => {
            if request.target_language != "none"
                || request.translation_mode != "none"
                || request.technical_translation
                || request.provider_account_file.is_some()
                || request.provider_model.is_some()
                || request.translation_consent
            {
                return Err(
                    "translation fields must be empty when translationProvider is none".into(),
                );
            }
        }
        "openai_api" | "gemini_api" => {
            if !matches!(request.target_language.as_str(), "en" | "vi") {
                return Err("provider translation target must be en or vi".into());
            }
            if request.translation_mode != "technical_context" || !request.technical_translation {
                return Err("provider translation requires technical_context mode".into());
            }
            let account_file = request
                .provider_account_file
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "providerAccountFile is required for translation".to_string())?;
            if account_file.chars().any(char::is_control) {
                return Err("providerAccountFile contains invalid characters".into());
            }
            let model = request
                .provider_model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "providerModel is required for translation".to_string())?;
            if model.chars().count() > 256 || model.chars().any(char::is_control) {
                return Err("providerModel is invalid".into());
            }
            if !request.translation_consent {
                return Err("explicit translation consent is required".into());
            }
        }
        _ => return Err("unsupported translationProvider".into()),
    }
    Ok(())
}

fn build_worker_request(
    request: &StartJobRequest,
    account_store: &ProviderAccountStore,
) -> Result<WorkerStartJobRequest, String> {
    let provider = match request.translation_provider.as_str() {
        "openai_api" => Some(Provider::OpenAi),
        "gemini_api" => Some(Provider::Gemini),
        _ => None,
    };
    let runtime = match provider {
        Some(provider) => {
            let file_name = request
                .provider_account_file
                .as_deref()
                .ok_or_else(|| "providerAccountFile is required for translation".to_string())?;
            Some(account_store.resolve_runtime_account(provider, file_name)?)
        }
        None => None,
    };
    Ok(WorkerStartJobRequest {
        request: request.clone(),
        provider_api_key: runtime.as_ref().map(|account| account.api_key.clone()),
        provider_base_url: runtime.map(|account| account.base_url),
    })
}

fn spawn_worker(
    request: &StartJobRequest,
) -> Result<(Child, std::process::ChildStdout, std::process::ChildStderr), String> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "unable to resolve repository root".to_string())?
        .to_path_buf();
    let mut failures = Vec::new();
    for python in python_candidates(&repo_root) {
        let mut command = Command::new(&python);
        command
            .args(["-m", "worker.main"])
            .current_dir(&repo_root)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match command.spawn() {
            Ok(mut child) => {
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| "worker stdout was not piped".to_string())?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| "worker stderr was not piped".to_string())?;
                return Ok((child, stdout, stderr));
            }
            Err(error) => failures.push(format!("{}: {error}", python.display())),
        }
    }
    Err(format!(
        "unable to start Python worker for {} ({})",
        request.job_id,
        failures.join("; ")
    ))
}

fn python_candidates(repo_root: &Path) -> Vec<PathBuf> {
    if let Some(configured) = env::var_os("WHISPERSUB_PYTHON") {
        return vec![PathBuf::from(configured)];
    }
    let mut candidates = vec![
        repo_root.join("worker/.venv/bin/python"),
        repo_root.join(".venv/bin/python"),
    ];
    candidates.retain(|path| path.is_file());
    candidates.extend(["python3.12", "python3.11", "python3"].map(PathBuf::from));
    candidates
}

fn bridge_worker_events(
    app: AppHandle,
    job_id: String,
    child: Arc<Mutex<Child>>,
    stdout: std::process::ChildStdout,
) {
    // React advances the queue as soon as it receives a terminal event. Keep that
    // event private until this process has exited and its registry slot is free.
    let mut pending_terminal_event = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                pending_terminal_event = Some(error_event(
                    &job_id,
                    "WORKER_IO_FAILED",
                    error.to_string(),
                    true,
                ));
                break;
            }
        };
        match route_worker_event(&line, &job_id) {
            Ok(WorkerEventRoute::Emit(event)) => {
                let _ = app.emit(JOB_EVENT_NAME, event);
            }
            Ok(WorkerEventRoute::DeferTerminal(event)) => {
                pending_terminal_event = Some(event);
                break;
            }
            Err(error) => {
                pending_terminal_event =
                    Some(error_event(&job_id, "WORKER_PROTOCOL_FAILED", error, false));
                if let Ok(mut process) = child.lock() {
                    let _ = process.kill();
                }
                break;
            }
        }
    }

    let status = child
        .lock()
        .ok()
        .and_then(|mut process| process.wait().ok());
    let state = app.state::<JobRuntime>();
    let cancelled = state.finish(&job_id).unwrap_or(false);

    let terminal_event =
        terminal_event_after_cleanup(&job_id, pending_terminal_event, cancelled, status);
    let _ = app.emit(JOB_EVENT_NAME, terminal_event);
}

fn terminal_event_after_cleanup(
    job_id: &str,
    pending_terminal_event: Option<serde_json::Value>,
    cancelled: bool,
    status: Option<ExitStatus>,
) -> serde_json::Value {
    if cancelled {
        serde_json::json!({ "type": "cancelled", "jobId": job_id })
    } else {
        pending_terminal_event.unwrap_or_else(|| {
            let detail = status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown exit status".into());
            error_event(
                &job_id,
                "WORKER_EXITED",
                format!("worker exited without a terminal event: {detail}"),
                true,
            )
        })
    }
}

enum WorkerEventRoute {
    Emit(serde_json::Value),
    DeferTerminal(serde_json::Value),
}

fn route_worker_event(line: &str, expected_job_id: &str) -> Result<WorkerEventRoute, String> {
    let (event, terminal) = validate_worker_event(line, expected_job_id)?;
    if terminal {
        Ok(WorkerEventRoute::DeferTerminal(event))
    } else {
        Ok(WorkerEventRoute::Emit(event))
    }
}

fn validate_worker_event(
    line: &str,
    expected_job_id: &str,
) -> Result<(serde_json::Value, bool), String> {
    let event: serde_json::Value =
        serde_json::from_str(line).map_err(|error| format!("invalid worker JSON: {error}"))?;
    let event_type = event
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "worker event type is missing".to_string())?;
    let allowed = [
        "job_started",
        "phase_changed",
        "progress",
        "segment",
        "completed",
        "cancelled",
        "error",
    ];
    if !allowed.contains(&event_type) {
        return Err(format!("unsupported worker event: {event_type}"));
    }
    if event.get("jobId").and_then(serde_json::Value::as_str) != Some(expected_job_id) {
        return Err("worker event jobId does not match the active job".into());
    }
    let terminal = matches!(event_type, "completed" | "cancelled" | "error");
    Ok((event, terminal))
}

fn error_event(job_id: &str, code: &str, message: String, retryable: bool) -> serde_json::Value {
    serde_json::json!({
        "type": "error",
        "jobId": job_id,
        "code": code,
        "message": message,
        "retryable": retryable,
    })
}

fn forward_stderr(stderr: std::process::ChildStderr, job_id: String) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("[worker {job_id}] {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_worker_request, python_candidates, route_worker_event, spawn_worker,
        terminal_event_after_cleanup, terminate_worker, validate_output_locations_blocking,
        validate_request, validate_worker_event, JobRuntime, StartJobRequest,
        ValidateOutputLocationsRequest, WorkerEventRoute, WorkerLifecycle,
    };
    use crate::openai_accounts::{Provider, ProviderAccountStore};
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        path::Path,
        process::{Command, Stdio},
        sync::{mpsc, Arc, Barrier, Mutex},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn sample_request(input_path: &str) -> StartJobRequest {
        StartJobRequest {
            request_type: "start_job".into(),
            job_id: "job_01".into(),
            input_path: input_path.into(),
            output_location_mode: "same_as_input".into(),
            output_directory: None,
            model: "small".into(),
            source_language: "auto".into(),
            target_language: "none".into(),
            task: "transcribe".into(),
            translation_provider: "none".into(),
            translation_mode: "none".into(),
            technical_translation: false,
            glossary: None,
            provider_account_file: None,
            provider_model: None,
            translation_consent: false,
            device: "auto".into(),
            output_formats: vec!["srt".into()],
            overwrite_policy: "suffix".into(),
        }
    }

    #[test]
    fn validates_same_as_input_directories_before_queue_start() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "whispersub-output-validation-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("output fixture directory should be created");
        let input_path = root.join("lesson.mp4");
        fs::write(&input_path, b"fixture").expect("input fixture should be written");

        let result = validate_output_locations_blocking(ValidateOutputLocationsRequest {
            input_paths: vec![input_path.to_string_lossy().into_owned()],
            output_location_mode: "same_as_input".into(),
            output_directory: None,
        });

        assert!(result.valid);
        assert_eq!(result.code, None);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_custom_output_without_a_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "whispersub-output-required-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("output fixture directory should be created");
        let input_path = root.join("lesson.mp4");
        fs::write(&input_path, b"fixture").expect("input fixture should be written");

        let result = validate_output_locations_blocking(ValidateOutputLocationsRequest {
            input_paths: vec![input_path.to_string_lossy().into_owned()],
            output_location_mode: "custom_directory".into(),
            output_directory: None,
        });

        assert!(!result.valid);
        assert_eq!(result.code.as_deref(), Some("DIRECTORY_REQUIRED"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn concurrent_starts_reserve_only_one_worker_slot() {
        let runtime = Arc::new(JobRuntime::default());
        let start = Arc::new(Barrier::new(3));
        let finish = Arc::new(Barrier::new(3));
        let attempts = (1..=2)
            .map(|number| {
                let runtime = Arc::clone(&runtime);
                let start = Arc::clone(&start);
                let finish = Arc::clone(&finish);
                thread::spawn(move || {
                    start.wait();
                    let reservation = runtime.reserve_start(&format!("job_{number:02}")).ok();
                    finish.wait();
                    reservation.is_some()
                })
            })
            .collect::<Vec<_>>();

        start.wait();
        finish.wait();
        let successful_starts = attempts
            .into_iter()
            .map(|attempt| attempt.join().expect("start attempt should not panic"))
            .filter(|succeeded| *succeeded)
            .count();

        assert_eq!(successful_starts, 1);
    }

    #[test]
    fn preserves_cancel_requested_while_worker_is_starting() {
        let mut lifecycle = WorkerLifecycle::<&str>::default();
        lifecycle
            .reserve_start("job_01")
            .expect("job should reserve the worker slot");

        assert!(lifecycle
            .register_starting_worker("job_01", "worker-handle")
            .is_ok());
        assert_eq!(lifecycle.request_cancel("job_01"), Some(&"worker-handle"));
        let cancel_requested = lifecycle
            .commit_start("job_01")
            .expect("reserved job should transition to running");

        assert!(cancel_requested);
    }

    #[test]
    fn cancel_can_kill_registered_worker_before_request_delivery() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep fixture should spawn");
        let mut stdin = child.stdin.take().expect("fixture stdin should be piped");
        let worker = Arc::new(Mutex::new(child));
        let mut lifecycle = WorkerLifecycle::default();
        lifecycle
            .reserve_start("job_01")
            .expect("job should reserve the worker slot");
        lifecycle
            .register_starting_worker("job_01", Arc::clone(&worker))
            .expect("spawned child should be cancellable before request delivery");

        let (started_tx, started_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            started_tx.send(()).expect("writer should signal start");
            stdin.write_all(&vec![b'x'; 1024 * 1024])
        });
        started_rx.recv().expect("writer should start");

        let cancel_target = lifecycle
            .request_cancel("job_01")
            .cloned()
            .expect("starting worker should expose its kill handle");
        super::kill_child(
            &mut cancel_target
                .lock()
                .expect("worker process lock should be available"),
        )
        .expect("cancel should kill the starting worker");
        let write_result = writer.join().expect("writer should not panic");
        terminate_worker(&worker);

        assert!(write_result.is_err());
    }

    #[test]
    fn rolls_back_worker_slot_when_start_reservation_is_dropped() {
        let runtime = JobRuntime::default();
        {
            let _reservation = runtime
                .reserve_start("job_01")
                .expect("first job should reserve the worker slot");
        }

        runtime
            .reserve_start("job_02")
            .expect("failed start must release the worker slot");
    }

    #[test]
    fn accepted_cancel_wins_over_pending_completed_event() {
        let completed = serde_json::json!({
            "type": "completed",
            "jobId": "job_01",
            "outputs": ["/tmp/lesson.srt"]
        });

        let terminal = terminal_event_after_cleanup("job_01", Some(completed), true, None);

        assert_eq!(terminal["type"], "cancelled");
        assert_eq!(terminal["jobId"], "job_01");
    }

    #[test]
    fn accepts_matching_terminal_event() {
        let (event, terminal) = validate_worker_event(
            r#"{"type":"completed","jobId":"job_01","outputs":["/tmp/a.srt"]}"#,
            "job_01",
        )
        .expect("event should be valid");
        assert_eq!(event["type"], "completed");
        assert!(terminal);
    }

    #[test]
    fn defers_terminal_event_until_worker_cleanup() {
        let route = route_worker_event(
            r#"{"type":"completed","jobId":"job_01","outputs":["/tmp/a.srt"]}"#,
            "job_01",
        )
        .expect("terminal event should be valid");

        match route {
            WorkerEventRoute::DeferTerminal(event) => {
                assert_eq!(event["type"], "completed");
            }
            WorkerEventRoute::Emit(_) => panic!("terminal event must wait for worker cleanup"),
        }
    }

    #[test]
    fn forwards_non_terminal_event_without_waiting_for_cleanup() {
        let route = route_worker_event(
            r#"{"type":"progress","jobId":"job_01","phase":"transcribing","percent":50}"#,
            "job_01",
        )
        .expect("progress event should be valid");

        match route {
            WorkerEventRoute::Emit(event) => assert_eq!(event["type"], "progress"),
            WorkerEventRoute::DeferTerminal(_) => {
                panic!("non-terminal event should be forwarded immediately")
            }
        }
    }

    #[test]
    fn rejects_cross_job_event() {
        let error = validate_worker_event(
            r#"{"type":"progress","jobId":"other","phase":"transcribing","percent":1}"#,
            "job_01",
        )
        .expect_err("cross-job events must be rejected");
        assert!(error.contains("does not match"));
    }

    #[test]
    fn validates_local_only_request() {
        let request = sample_request("/missing.mp4");
        assert!(super::validate_request(&request).is_err());
    }

    #[test]
    fn resolves_translation_credentials_only_for_the_worker_request() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "whispersub-worker-translation-{}-{nonce}",
            std::process::id()
        ));
        let store = ProviderAccountStore::new(root.clone());
        let state = store
            .create(
                Provider::OpenAi,
                "Work",
                "sk-test-worker-key",
                "https://api.openai.com/v1",
            )
            .expect("account should be created");
        let input_path = root.join("lesson.mp4");
        fs::write(&input_path, b"fixture").expect("input fixture should be written");
        let mut request = sample_request(input_path.to_string_lossy().as_ref());
        request.target_language = "vi".into();
        request.translation_provider = "openai_api".into();
        request.translation_mode = "technical_context".into();
        request.technical_translation = true;
        request.glossary = Some("software-engineering-default".into());
        request.provider_account_file = Some(state.accounts[0].file_name.clone());
        request.provider_model = Some("gpt-5.6-luna".into());
        request.translation_consent = true;

        validate_request(&request).expect("consented translation should be valid");
        let external_json = serde_json::to_string(&request).expect("request should serialize");
        assert!(!external_json.contains("providerApiKey"));
        assert!(!external_json.contains("sk-test-worker-key"));

        let worker_request = build_worker_request(&request, &store)
            .expect("worker request should resolve account runtime");
        let worker_json =
            serde_json::to_string(&worker_request).expect("worker request should serialize");
        assert!(worker_json.contains("providerApiKey"));
        assert!(worker_json.contains("sk-test-worker-key"));
        assert!(worker_json.contains("https://api.openai.com/v1"));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn resolves_gemini_runtime_and_rejects_cross_provider_account_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "whispersub-worker-gemini-{}-{nonce}",
            std::process::id()
        ));
        let store = ProviderAccountStore::new(root.clone());
        let openai = store
            .create(
                Provider::OpenAi,
                "OpenAI",
                "sk-test-openai-key",
                "https://api.openai.com/v1",
            )
            .expect("OpenAI account should be created");
        let gemini = store
            .create(
                Provider::Gemini,
                "Gemini",
                "test-gemini-worker-key",
                "https://generativelanguage.googleapis.com",
            )
            .expect("Gemini account should be created");
        let input_path = root.join("lesson.mp4");
        fs::write(&input_path, b"fixture").expect("input fixture should be written");
        let mut request = sample_request(input_path.to_string_lossy().as_ref());
        request.target_language = "vi".into();
        request.translation_provider = "gemini_api".into();
        request.translation_mode = "technical_context".into();
        request.technical_translation = true;
        request.provider_account_file = Some(gemini.accounts[0].file_name.clone());
        request.provider_model = Some("gemini-3.5-flash".into());
        request.translation_consent = true;

        validate_request(&request).expect("consented Gemini translation should be valid");
        let worker_json = serde_json::to_string(
            &build_worker_request(&request, &store).expect("Gemini runtime should resolve"),
        )
        .expect("worker request should serialize");
        assert!(worker_json.contains("test-gemini-worker-key"));
        assert!(worker_json.contains("https://generativelanguage.googleapis.com"));

        request.provider_account_file = Some(openai.accounts[0].file_name.clone());
        let error = build_worker_request(&request, &store)
            .err()
            .expect("cross-provider account must fail closed");
        assert!(error.contains("provider") || error.contains("account"));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_translation_without_explicit_consent() {
        let mut request = sample_request("/missing.mp4");
        request.target_language = "vi".into();
        request.translation_provider = "openai_api".into();
        request.translation_mode = "technical_context".into();
        request.technical_translation = true;
        request.provider_account_file = Some("openai_work_1.json".into());
        request.provider_model = Some("gpt-5.6-luna".into());

        let error = validate_request(&request).expect_err("consent must be required");
        assert!(error.contains("consent"));
    }

    #[test]
    fn python_process_round_trip_returns_typed_events() {
        let request = sample_request("/definitely/missing/Bài học.mp4");
        let (mut child, stdout, _stderr) = spawn_worker(&request).expect("worker should start");
        let mut stdin = child.stdin.take().expect("stdin should be piped");
        writeln!(
            stdin,
            "{}",
            serde_json::to_string(&request).expect("request should serialize")
        )
        .expect("request should be written");
        drop(stdin);

        let events: Vec<serde_json::Value> = BufReader::new(stdout)
            .lines()
            .map(|line| {
                serde_json::from_str(&line.expect("worker line should be readable"))
                    .expect("worker line should be JSON")
            })
            .collect();
        let status = child.wait().expect("worker should exit");

        assert!(!status.success());
        assert_eq!(
            events.first().and_then(|event| event["type"].as_str()),
            Some("job_started")
        );
        assert_eq!(
            events.last().and_then(|event| event["type"].as_str()),
            Some("error")
        );
        assert_eq!(
            events.last().and_then(|event| event["code"].as_str()),
            Some("INVALID_INPUT")
        );
    }

    #[test]
    fn always_has_path_fallbacks_for_python() {
        let candidates = python_candidates(Path::new("/definitely/missing"));
        assert!(candidates
            .iter()
            .any(|path| path == Path::new("python3.12")));
    }
}
