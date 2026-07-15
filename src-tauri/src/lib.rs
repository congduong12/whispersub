mod worker_job;

use worker_job::{cancel_transcription_job, health_check, start_transcription_job, JobRuntime};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(JobRuntime::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            start_transcription_job,
            cancel_transcription_job
        ])
        .run(tauri::generate_context!())
        .expect("failed to run WhisperSub");
}
