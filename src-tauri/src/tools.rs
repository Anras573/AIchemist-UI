use serde::Serialize;
use std::path::Path;
use std::process::Command;

// ── Return types ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub struct WriteFileResult {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Serialize)]
pub struct DeleteFileResult {
    pub path: String,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub struct ListDirectoryResult {
    pub path: String,
    pub entries: Vec<DirEntry>,
}

#[derive(Serialize)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Read the contents of a file. Returns an error string if the file cannot be
/// read (does not exist, permission denied, binary content, etc.).
#[tauri::command]
pub fn read_file(path: String) -> Result<ReadFileResult, String> {
    let p = Path::new(&path);
    let content = std::fs::read_to_string(p)
        .map_err(|e| format!("read_file failed for '{}': {}", path, e))?;
    let size_bytes = content.len() as u64;
    Ok(ReadFileResult { content, path, size_bytes })
}

/// Write text content to a file, creating parent directories as needed.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<WriteFileResult, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("write_file: could not create parent dirs for '{}': {}", path, e))?;
    }
    let bytes_written = content.len();
    std::fs::write(p, &content)
        .map_err(|e| format!("write_file failed for '{}': {}", path, e))?;
    Ok(WriteFileResult { path, bytes_written })
}

/// Delete a file (not a directory).
#[tauri::command]
pub fn delete_file(path: String) -> Result<DeleteFileResult, String> {
    let p = Path::new(&path);
    if p.is_dir() {
        return Err(format!("delete_file: '{}' is a directory; use delete_directory instead", path));
    }
    std::fs::remove_file(p)
        .map_err(|e| format!("delete_file failed for '{}': {}", path, e))?;
    Ok(DeleteFileResult { path })
}

/// List the immediate children of a directory (non-recursive).
#[tauri::command]
pub fn list_directory(path: String) -> Result<ListDirectoryResult, String> {
    let p = Path::new(&path);
    let read_dir = std::fs::read_dir(p)
        .map_err(|e| format!("list_directory failed for '{}': {}", path, e))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry_res in read_dir {
        let entry = entry_res
            .map_err(|e| format!("list_directory: error reading entry: {}", e))?;
        let meta = entry.metadata()
            .map_err(|e| format!("list_directory: metadata error: {}", e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_path = entry.path().to_string_lossy().into_owned();
        let is_dir = meta.is_dir();
        let size_bytes = if is_dir { 0 } else { meta.len() };
        entries.push(DirEntry { name, path: entry_path, is_dir, size_bytes });
    }

    // Sort: directories first, then files, both alphabetically
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(ListDirectoryResult { path, entries })
}

// ── Web fetch ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct WebFetchResult {
    pub url: String,
    pub status: u16,
    pub body: String,
    pub content_type: String,
}

/// Fetch a URL via HTTP GET and return the response body as text.
/// Follows redirects, times out after 30 seconds, and returns a structured
/// result rather than erroring on non-2xx status codes (caller decides what to do).
#[tauri::command]
pub fn web_fetch(url: String) -> Result<WebFetchResult, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("AIchemist/0.1 (agent tool)")
        .build()
        .map_err(|e| format!("web_fetch: failed to build client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("web_fetch: request to '{}' failed: {}", url, e))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/plain")
        .to_owned();

    let body = response
        .text()
        .map_err(|e| format!("web_fetch: failed to read response body: {}", e))?;

    Ok(WebFetchResult { url, status, body, content_type })
}

/// Execute a shell command using `/bin/sh -c`. Captures stdout, stderr, and
/// exit code. Times out after 60 seconds. Never panics — errors become an
/// ExecResult with exit_code -1.
#[tauri::command]
pub fn execute_bash(command: String, cwd: Option<String>) -> Result<ExecResult, String> {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(&command);

    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    let output = cmd.output()
        .map_err(|e| format!("execute_bash: failed to spawn process: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(ExecResult { stdout, stderr, exit_code })
}
