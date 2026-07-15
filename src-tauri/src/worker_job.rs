use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

const JOB_EVENT_NAME: &str = "whispersub://job-event";

#[derive(Default)]
pub struct JobRuntime {
    workers: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    cancelled: Mutex<HashSet<String>>,
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
    provider_model: Option<String>,
    device: String,
    output_formats: Vec<String>,
    overwrite_policy: String,
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
    request: StartJobRequest,
) -> Result<(), String> {
    validate_request(&request)?;
    {
        let workers = state
            .workers
            .lock()
            .map_err(|_| "job runtime lock poisoned")?;
        if !workers.is_empty() {
            return Err("another transcription job is already active".into());
        }
    }
    state
        .cancelled
        .lock()
        .map_err(|_| "job runtime lock poisoned")?
        .remove(&request.job_id);

    let (mut child, stdout, stderr) = spawn_worker(&request)?;
    let request_line = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "worker stdin was not piped".to_string())?;
    stdin
        .write_all(format!("{request_line}\n").as_bytes())
        .map_err(|error| format!("failed to write worker request: {error}"))?;
    drop(stdin);

    let child = Arc::new(Mutex::new(child));
    state
        .workers
        .lock()
        .map_err(|_| "job runtime lock poisoned")?
        .insert(request.job_id.clone(), Arc::clone(&child));

    let job_id = request.job_id.clone();
    thread::spawn(move || forward_stderr(stderr, job_id));
    tauri::async_runtime::spawn_blocking(move || {
        bridge_worker_events(app, request.job_id, child, stdout)
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_transcription_job(
    state: State<'_, JobRuntime>,
    job_id: String,
) -> Result<(), String> {
    state
        .cancelled
        .lock()
        .map_err(|_| "job runtime lock poisoned")?
        .insert(job_id.clone());

    let worker = state
        .workers
        .lock()
        .map_err(|_| "job runtime lock poisoned")?
        .get(&job_id)
        .cloned();
    if let Some(worker) = worker {
        let mut child = worker.lock().map_err(|_| "worker process lock poisoned")?;
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            child
                .kill()
                .map_err(|error| format!("failed to cancel worker: {error}"))?;
        }
    }
    Ok(())
}

fn validate_request(request: &StartJobRequest) -> Result<(), String> {
    if request.request_type != "start_job" {
        return Err("request type must be start_job".into());
    }
    if request.job_id.trim().is_empty() {
        return Err("jobId must not be empty".into());
    }
    let input = Path::new(&request.input_path);
    if !input.is_file() {
        return Err(format!(
            "inputPath is not a readable file: {}",
            request.input_path
        ));
    }
    if request.task != "transcribe" || request.translation_provider != "none" {
        return Err("WS-003 only supports local transcription without a provider".into());
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
    let mut terminal_seen = false;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                emit_error(&app, &job_id, "WORKER_IO_FAILED", error.to_string(), true);
                terminal_seen = true;
                break;
            }
        };
        match validate_worker_event(&line, &job_id) {
            Ok((event, terminal)) => {
                let _ = app.emit(JOB_EVENT_NAME, event);
                if terminal {
                    terminal_seen = true;
                    break;
                }
            }
            Err(error) => {
                emit_error(&app, &job_id, "WORKER_PROTOCOL_FAILED", error, false);
                terminal_seen = true;
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
    if let Ok(mut workers) = state.workers.lock() {
        workers.remove(&job_id);
    }
    let cancelled = state
        .cancelled
        .lock()
        .map(|mut jobs| jobs.remove(&job_id))
        .unwrap_or(false);

    if !terminal_seen {
        if cancelled {
            let _ = app.emit(
                JOB_EVENT_NAME,
                serde_json::json!({ "type": "cancelled", "jobId": job_id }),
            );
        } else {
            let detail = status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown exit status".into());
            emit_error(
                &app,
                &job_id,
                "WORKER_EXITED",
                format!("worker exited without a terminal event: {detail}"),
                true,
            );
        }
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

fn emit_error(app: &AppHandle, job_id: &str, code: &str, message: String, retryable: bool) {
    let _ = app.emit(
        JOB_EVENT_NAME,
        serde_json::json!({
            "type": "error",
            "jobId": job_id,
            "code": code,
            "message": message,
            "retryable": retryable,
        }),
    );
}

fn forward_stderr(stderr: std::process::ChildStderr, job_id: String) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("[worker {job_id}] {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::{python_candidates, spawn_worker, validate_worker_event, StartJobRequest};
    use std::{
        io::{BufRead, BufReader, Write},
        path::Path,
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
            provider_model: None,
            device: "auto".into(),
            output_formats: vec!["srt".into()],
            overwrite_policy: "suffix".into(),
        }
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
