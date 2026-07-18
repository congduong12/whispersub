mod openai_accounts;
mod worker_job;

use openai_accounts::{
    create_provider_account, delete_provider_account, list_provider_accounts, list_provider_models,
    set_active_provider_account, test_provider_connection, update_provider_account,
    ProviderAccountStore,
};
use worker_job::{cancel_transcription_job, health_check, start_transcription_job, JobRuntime};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(JobRuntime::default())
        .setup(|app| {
            use tauri::Manager;

            let root = app
                .path()
                .home_dir()
                .map_err(|error| format!("failed to resolve user home directory: {error}"))?
                .join(".whispersub");
            app.manage(ProviderAccountStore::new(root));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            start_transcription_job,
            cancel_transcription_job,
            list_provider_accounts,
            list_provider_models,
            create_provider_account,
            update_provider_account,
            set_active_provider_account,
            delete_provider_account,
            test_provider_connection
        ])
        .run(tauri::generate_context!())
        .expect("failed to run WhisperSub");
}
