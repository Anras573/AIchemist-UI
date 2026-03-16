mod config;
mod db;
mod projects;
mod sessions;
mod tools;

use std::sync::Mutex;
use rusqlite::Connection;

/// Shared application state — handed to every Tauri command via `tauri::State<AppState>`.
pub struct AppState {
    pub db: Mutex<Connection>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load ~/.aichemist/.env if it exists (API keys, etc.). Errors are non-fatal.
    let env_path = dirs_next::home_dir()
        .map(|h| h.join(".aichemist").join(".env"));
    if let Some(path) = env_path {
        let _ = dotenvy::from_path(path);
    }

    let conn = db::open().expect("failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { db: Mutex::new(conn) })
        .invoke_handler(tauri::generate_handler![
            // Config
            config::get_api_key,
            config::get_anthropic_config,
            // Projects
            projects::add_project,
            projects::list_projects,
            projects::remove_project,
            projects::get_project_config,
            projects::save_project_config,
            // Sessions
            sessions::create_session,
            sessions::list_sessions,
            sessions::get_session,
            sessions::delete_session,
            sessions::save_message,
            sessions::update_session_title,
            // Tools — filesystem + shell + web
            tools::read_file,
            tools::write_file,
            tools::delete_file,
            tools::list_directory,
            tools::execute_bash,
            tools::web_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
