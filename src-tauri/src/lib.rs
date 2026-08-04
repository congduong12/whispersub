mod local_storage;
mod openai_accounts;
mod worker_job;
mod youtube_library;

use local_storage::{get_local_storage_info, remember_output_directory, LocalStorage};
use openai_accounts::{
    create_provider_account, delete_provider_account, list_provider_accounts, list_provider_models,
    set_active_provider_account, test_provider_connection, update_provider_account,
    ProviderAccountStore,
};
use worker_job::{
    cancel_transcription_job, health_check, scavenge_orphaned_workspaces, start_transcription_job,
    validate_output_locations, JobRuntime,
};
use youtube_library::{
    delete_youtube_library_item, get_youtube_library_item, list_youtube_library,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(JobRuntime::default())
        .setup(|app| {
            use tauri::Manager;

            if let Err(error) = scavenge_orphaned_workspaces() {
                eprintln!("workspace startup cleanup deferred: {error}");
            }

            let root = app
                .path()
                .home_dir()
                .map_err(|error| format!("failed to resolve user home directory: {error}"))?
                .join(".whispersub");
            app.manage(ProviderAccountStore::new(root));
            let documents_dir = app
                .path()
                .document_dir()
                .map_err(|error| format!("failed to resolve Documents directory: {error}"))?;
            let app_data_dir = app.path().app_data_dir().map_err(|error| {
                format!("failed to resolve Application Support directory: {error}")
            })?;
            app.manage(LocalStorage::new(documents_dir, app_data_dir));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            health_check,
            get_local_storage_info,
            remember_output_directory,
            validate_output_locations,
            start_transcription_job,
            cancel_transcription_job,
            list_provider_accounts,
            list_provider_models,
            create_provider_account,
            update_provider_account,
            set_active_provider_account,
            delete_provider_account,
            test_provider_connection,
            list_youtube_library,
            get_youtube_library_item,
            delete_youtube_library_item
        ])
        .run(tauri::generate_context!())
        .expect("failed to run WhisperSub");
}
