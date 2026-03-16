/**
 * IPC channel name constants — shared contract between main process and preload/renderer.
 *
 * Main process registers: ipcMain.handle(CH.*, handler)
 * Preload exposes:        ipcRenderer.invoke(CH.*, args)
 * Renderer calls:         window.electronAPI.<method>(args)
 *
 * Renderer-bound push events (main → renderer via webContents.send):
 *   SESSION_STATUS, SESSION_DELTA, SESSION_TOOL_CALL, SESSION_TOOL_RESULT,
 *   SESSION_APPROVAL_REQUIRED
 */

// ── Config ───────────────────────────────────────────────────────────────────
export const GET_API_KEY            = "config:get-api-key";
export const GET_ANTHROPIC_CONFIG   = "config:get-anthropic-config";

// ── Projects ─────────────────────────────────────────────────────────────────
export const ADD_PROJECT            = "projects:add";
export const LIST_PROJECTS          = "projects:list";
export const REMOVE_PROJECT         = "projects:remove";
export const GET_PROJECT_CONFIG     = "projects:get-config";
export const SAVE_PROJECT_CONFIG    = "projects:save-config";

// ── Sessions ─────────────────────────────────────────────────────────────────
export const CREATE_SESSION         = "sessions:create";
export const LIST_SESSIONS          = "sessions:list";
export const GET_SESSION            = "sessions:get";
export const DELETE_SESSION         = "sessions:delete";
export const SAVE_MESSAGE           = "sessions:save-message";
export const UPDATE_SESSION_TITLE   = "sessions:update-title";

// ── File system (renderer direct use — ContextPanel) ────────────────────────
export const LIST_DIRECTORY         = "fs:list-directory";

// ── Dialog ───────────────────────────────────────────────────────────────────
export const OPEN_FOLDER_DIALOG     = "dialog:open-folder";

// ── Agent ────────────────────────────────────────────────────────────────────
export const AGENT_SEND             = "agent:send";
export const APPROVE_TOOL_CALL      = "agent:approve-tool-call";

// ── Settings ──────────────────────────────────────────────────────────────────
export const SETTINGS_READ          = "settings:read";
export const SETTINGS_WRITE         = "settings:write";
export const SESSION_STATUS           = "session:status";
export const SESSION_DELTA            = "session:delta";
export const SESSION_TOOL_CALL        = "session:tool_call";
export const SESSION_TOOL_RESULT      = "session:tool_result";
export const SESSION_APPROVAL_REQUIRED = "session:approval_required";
export const SESSION_MESSAGE          = "session:message";
