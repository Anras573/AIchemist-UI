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
export const UPDATE_SESSION_MODEL   = "sessions:update-model";
export const UPDATE_SESSION_AGENT   = "sessions:update-agent";
export const UPDATE_SESSION_SKILLS  = "sessions:update-skills";

// ── File system (renderer direct use — ContextPanel) ────────────────────────
export const LIST_DIRECTORY         = "fs:list-directory";
export const READ_FILE              = "fs:read-file";

// ── Dialog ───────────────────────────────────────────────────────────────────
export const OPEN_FOLDER_DIALOG     = "dialog:open-folder";

// ── Agent ────────────────────────────────────────────────────────────────────
export const AGENT_SEND             = "agent:send";
export const APPROVE_TOOL_CALL      = "agent:approve-tool-call";
export const GET_COPILOT_MODELS     = "agent:get-copilot-models";
export const GET_CLAUDE_AGENTS      = "agent:get-claude-agents";
export const GET_COPILOT_AGENTS     = "agent:get-copilot-agents";
export const LIST_SKILLS            = "agent:list-skills";

// ── Agent / Skill file management ────────────────────────────────────────────
export const WRITE_AGENT_FILE   = "agents:write-file";
export const DELETE_AGENT_FILE  = "agents:delete-file";
export const CREATE_AGENT       = "agents:create";
export const WRITE_SKILL_FILE   = "agents:write-skill";
export const DELETE_SKILL_DIR   = "agents:delete-skill";
export const CREATE_SKILL       = "agents:create-skill";

// ── Settings ──────────────────────────────────────────────────────────────────
export const SETTINGS_READ          = "settings:read";
export const SETTINGS_WRITE         = "settings:write";
export const SESSION_STATUS           = "session:status";
export const SESSION_DELTA            = "session:delta";
export const SESSION_TOOL_CALL        = "session:tool_call";
export const SESSION_TOOL_RESULT      = "session:tool_result";
export const SESSION_APPROVAL_REQUIRED = "session:approval_required";
export const SESSION_MESSAGE          = "session:message";
export const SESSION_TRACE            = "session:trace";

// ── Traces ────────────────────────────────────────────────────────────────────
export const GET_TRACES             = "traces:get";

// ── Changes (session file writes + git diff) ──────────────────────────────────
export const SESSION_FILE_CHANGE    = "session:file_change";
export const SESSION_COMPACTION     = "session:compaction";
export const GET_GIT_DIFF           = "fs:git-diff";
export const GET_GIT_BRANCH         = "fs:git-branch";

// ── Terminal (interactive PTY) ────────────────────────────────────────────────
export const TERMINAL_CREATE        = "terminal:create";
export const TERMINAL_INPUT         = "terminal:input";
export const TERMINAL_RESIZE        = "terminal:resize";
export const TERMINAL_CLOSE         = "terminal:close";
export const TERMINAL_OUTPUT        = "terminal:output"; // push: main → renderer

// ── Thinking / reasoning (push: main → renderer) ─────────────────────────────
export const SESSION_THINKING_DELTA = "session:thinking-delta";
export const SESSION_THINKING_DONE  = "session:thinking-done";
