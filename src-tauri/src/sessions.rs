use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Vec<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub messages: Vec<Message>,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Create a new idle session for a project.
#[tauri::command]
pub fn create_session(
    project_id: String,
    state: tauri::State<AppState>,
) -> Result<Session, String> {
    let id = Uuid::new_v4().to_string();
    let created_at = now_iso();

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?1, ?2, 'New session', 'idle', ?3)",
        params![id, project_id, created_at],
    )
    .map_err(|e| e.to_string())?;

    Ok(Session {
        id,
        project_id,
        title: "New session".into(),
        status: "idle".into(),
        created_at,
        messages: vec![],
    })
}

/// List all sessions for a project (metadata only — messages are not loaded).
#[tauri::command]
pub fn list_sessions(
    project_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<Session>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, title, status, created_at
             FROM sessions
             WHERE project_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let sessions = stmt
        .query_map(params![project_id], |row| {
            Ok(Session {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
                messages: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

/// Fetch a single session with its full message history.
#[tauri::command]
pub fn get_session(
    session_id: String,
    state: tauri::State<AppState>,
) -> Result<Session, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let mut session = conn
        .query_row(
            "SELECT id, project_id, title, status, created_at FROM sessions WHERE id = ?1",
            params![session_id],
            |row| {
                Ok(Session {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    messages: vec![],
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut msg_stmt = conn
        .prepare(
            "SELECT id, session_id, role, content, created_at
             FROM messages
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    session.messages = msg_stmt
        .query_map(params![session_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tool_calls: vec![],
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(session)
}

/// Hard-delete a session and its messages (cascade via foreign key).
#[tauri::command]
pub fn delete_session(
    session_id: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist a single message to SQLite and return it with its generated id.
#[tauri::command]
pub fn save_message(
    session_id: String,
    role: String,
    content: String,
    state: tauri::State<AppState>,
) -> Result<Message, String> {
    let id = Uuid::new_v4().to_string();
    let created_at = now_iso();

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, session_id, role, content, created_at],
    )
    .map_err(|e| e.to_string())?;

    Ok(Message {
        id,
        session_id,
        role,
        content,
        tool_calls: vec![],
        created_at,
    })
}

/// Update the session title (called after the first user message is processed).
#[tauri::command]
pub fn update_session_title(
    session_id: String,
    title: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET title = ?1 WHERE id = ?2",
        params![title, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
