use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

use crate::AppState;

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub config: ProjectConfig,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectConfig {
    pub provider: String,
    pub model: String,
    pub approval_mode: String,
    pub approval_rules: Vec<ApprovalRule>,
    pub custom_tools: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApprovalRule {
    pub tool_category: String,
    pub policy: String,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
            approval_mode: "custom".into(),
            approval_rules: vec![
                ApprovalRule { tool_category: "filesystem".into(), policy: "risky_only".into() },
                ApprovalRule { tool_category: "shell".into(), policy: "always".into() },
                ApprovalRule { tool_category: "web".into(), policy: "never".into() },
            ],
            custom_tools: vec![],
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn config_path(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path).join(".aichemist").join("config.json")
}

fn read_or_create_config(project_path: &str) -> ProjectConfig {
    let path = config_path(project_path);
    if path.exists() {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        let config = ProjectConfig::default();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&config).unwrap());
        config
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Open a folder as a project. Creates `.aichemist/config.json` if absent.
#[tauri::command]
pub fn add_project(path: String, state: tauri::State<AppState>) -> Result<Project, String> {
    let path = path.trim_end_matches('/').to_string();

    if !Path::new(&path).is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Project")
        .to_string();

    let config = read_or_create_config(&path);
    let id = Uuid::new_v4().to_string();
    let created_at = now_iso();

    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // INSERT OR IGNORE so re-opening an existing project is a no-op on the DB level
    conn.execute(
        "INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, path, created_at],
    )
    .map_err(|e| e.to_string())?;

    // Fetch the canonical row (handles the case where the project already existed)
    let row = conn
        .query_row(
            "SELECT id, name, path, created_at FROM projects WHERE path = ?1",
            params![path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(Project {
        id: row.0,
        name: row.1,
        path: row.2,
        created_at: row.3,
        config,
    })
}

/// Return all known projects, ordered by creation date.
#[tauri::command]
pub fn list_projects(state: tauri::State<AppState>) -> Result<Vec<Project>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|(id, name, path, created_at)| {
            let config = read_or_create_config(&path);
            Project { id, name, path, created_at, config }
        })
        .collect();

    Ok(projects)
}

/// Remove a project from the registry. Does NOT delete the folder.
#[tauri::command]
pub fn remove_project(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read `.aichemist/config.json` for a project.
#[tauri::command]
pub fn get_project_config(id: String, state: tauri::State<AppState>) -> Result<ProjectConfig, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let path: String = conn
        .query_row("SELECT path FROM projects WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(read_or_create_config(&path))
}

/// Write `.aichemist/config.json` for a project.
#[tauri::command]
pub fn save_project_config(
    id: String,
    config: ProjectConfig,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let path: String = conn
        .query_row("SELECT path FROM projects WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    drop(conn); // release lock before file I/O

    let cfg_path = config_path(&path);
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(cfg_path, json).map_err(|e| e.to_string())?;
    Ok(())
}
