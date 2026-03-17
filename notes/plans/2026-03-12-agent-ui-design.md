# AIchemist UI — Agent UI Design

**Date:** 2026-03-12
**Status:** Approved

---

## Overview

A project-focused desktop agent UI built with Tauri v2 + React + TypeScript. A "project" maps directly to a folder on disk (like a VS Code workspace). The app manages multiple projects in a single window, with each project supporting multiple concurrent agent sessions that continue running in the background when you switch away.

The core interaction model is a **split pane**: a timeline/log view on the left showing the agent's reasoning and tool calls, and an always-visible context panel on the right showing live file, terminal, and web context.

---

## Architecture

Three layers with clearly separated responsibilities:

```
┌─────────────────────────────────────────────────────────┐
│  React Frontend                                          │
│  - Renders session timeline + context panel              │
│  - Handles approval gate UI                              │
│  - Project/session navigation                            │
└────────────────┬──────────────────────┬─────────────────┘
                 │ invoke()             │ listen()
                 ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│  Rust Backend (Tauri)                                    │
│  - Session registry (all projects, all sessions)         │
│  - Tool execution (file ops, shell, web)                 │
│  - Approval queue                                        │
│  - Project config persistence                            │
└────────────────┬────────────────────────────────────────┘
                 │ invoke("execute_tool")
                 ▼
┌─────────────────────────────────────────────────────────┐
│  TypeScript / Vercel AI SDK                              │
│  - Owns the LLM conversation loop                        │
│  - Streaming from Claude / OpenAI / Ollama               │
│  - Tool call parsing → delegates execution to Rust       │
└─────────────────────────────────────────────────────────┘
```

### Key data flow

1. User sends a message in a session
2. React calls `invoke("send_message", { session_id, content })`
3. Rust stores the message and signals the TypeScript AI SDK layer
4. AI SDK calls the configured LLM provider with full session history + tool definitions
5. LLM streams response → TypeScript emits `session:delta` events → React renders live
6. When the LLM requests a tool call, TypeScript calls `invoke("execute_tool", { session_id, tool, args })`
7. Rust checks the project's approval config:
   - **Approved:** executes the tool, returns result to TypeScript, conversation continues
   - **Requires approval:** emits `session:approval_required` event → React shows `Confirmation` component → user approves/rejects → result flows back
8. Tool result is added to conversation history, LLM continues

### Sessions as background tasks

Sessions are **tokio async tasks** in Rust. They hold their full message history and tool call state. When the user switches projects or session tabs, React unsubscribes from that session's events but the task keeps running. On return, React re-subscribes and receives the current state snapshot plus any events it missed.

---

## Data Model

### Project
```typescript
{
  id: string;           // uuid
  name: string;
  path: string;         // absolute path to folder on disk
  created_at: string;
  config: ProjectConfig;
}
```

### ProjectConfig
Persisted to `{project_path}/.aichemist/config.json` — portable and git-committable.
```typescript
{
  provider: "anthropic" | "openai" | "ollama" | string;
  model: string;
  approval_mode: "all" | "none" | "custom";
  approval_rules: {
    tool_category: "filesystem" | "shell" | "web" | "custom";
    policy: "always" | "never" | "risky_only";
  }[];
  custom_tools: ToolDefinition[];
}
```

### Session
```typescript
{
  id: string;
  project_id: string;
  title: string;        // auto-generated from first user message
  status: "idle" | "running" | "waiting_approval" | "error" | "complete";
  created_at: string;
  messages: Message[];
}
```

### Message
```typescript
{
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[];
}
```

### ToolCall
```typescript
{
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown | null;
  status: "pending_approval" | "approved" | "rejected" | "complete" | "error";
  category: "filesystem" | "shell" | "web" | "custom";
}
```

### ToolDefinition (extensibility point)
```typescript
{
  name: string;
  description: string;
  parameters: JSONSchema;           // standard AI SDK tool format
  category: string;
  requires_approval: boolean | "inherit";  // inherit = use project config
}
```

---

## UI Components

Built on **AI Elements** (shadcn/ui foundation) wherever possible.

### Layout

```
┌──────────────┬────────────────────────────────────────────┐
│ ProjectSidebar│              WorkspaceView                  │
│ (collapsible)│  ┌─────────────────────────────────────┐   │
│              │  │         SessionTabBar                 │   │
│ ProjectList  │  └─────────────────────────────────────┘   │
│  └ ProjectItem│  ┌──────────────────┬──────────────────┐   │
│    (badge)   │  │  TimelinePanel   │  ContextPanel     │   │
│              │  │  (60%)           │  (40%)            │   │
│ AddProject   │  │  MessageList     │  [Files|Term|Web]  │   │
│              │  │  ApprovalGate    │  FileTreeView      │   │
│              │  │  MessageInput    │  TerminalView      │   │
│              │  └──────────────────┴──────────────────┘   │
└──────────────┴────────────────────────────────────────────┘
```

### Component → AI Elements mapping

| Component | AI Elements | Notes |
|---|---|---|
| `MessageList` | `Conversation` | Full session thread |
| `UserMessage` / `AssistantMessage` | `Message` | Streaming-aware |
| `ToolCallCard` | `Tool` | Expandable args + result |
| `ApprovalGate` | `Confirmation` | Inline, blocks `MessageInput` |
| `FileTreeView` | `FileTree` | Right panel, Files tab |
| `TerminalView` | `Terminal` | Right panel, Terminal tab |
| `SessionTab` status | `Queue` + `Task` | Status badge per tab |
| Streaming skeleton | `Shimmer` | While LLM is generating |
| Reasoning steps | `Chain of Thought` | Collapsible reasoning |
| Provider picker | `Model Selector` | Per-project config |

### Custom components (no AI Elements equivalent)

- **`ProjectSidebar`** — collapsible sidebar (~240px), project list with active session badge counts
- **`SessionTabBar`** — horizontal tabs (shadcn `Tabs`), each tab shows title + status dot
- **`CommandPalette`** — `Cmd+K` overlay using `cmdk`, project switcher + session search
- **`ContextPanel`** — shadcn `Tabs` wrapper switching between FileTree / Terminal / Web views; auto-switches to the relevant tab based on the last tool call category

### Navigation

- **Collapsible sidebar** — persistent project list, collapses to icon rail
- **`Cmd+K` quick switcher** — fuzzy search across all projects and their sessions
- **Session badge** — `ProjectItem` shows a count of active (running or waiting approval) sessions even when another project is selected

---

## Tool System

### Core tools (Rust-implemented)

| Tool | Category | Default approval |
|---|---|---|
| `read_file` | filesystem | never |
| `write_file` | filesystem | risky_only |
| `delete_file` | filesystem | always |
| `list_directory` | filesystem | never |
| `bash` | shell | risky_only |
| `web_search` | web | never |
| `web_fetch` | web | never |

### Custom tools

Defined in `ProjectConfig.custom_tools` as a `ToolDefinition[]`. The AI SDK's standard JSON Schema tool format is used directly, so tools are portable across providers. Custom tools specify whether they call back into Rust for execution or run entirely in TypeScript (e.g., a tool that calls an external API directly).

---

## Key Libraries

| Library | Role |
|---|---|
| `@ai-sdk/core` + provider packages | Multi-provider LLM streaming + tool call parsing |
| `ai-elements` | UI components (via shadcn registry CLI) |
| `shadcn/ui` | Base component primitives |
| `cmdk` | Command palette |
| `@tauri-apps/api` | Rust↔TypeScript bridge |
| `tokio` (Rust) | Async session task management |
| `serde_json` (Rust) | Tool args/result serialisation |

---

## Open Questions (deferred)

1. **Session persistence** — do sessions survive app restart? (SQLite in Rust vs. JSON files in project folder)
2. **Web context panel** — is this a full WebView or just a rendered result display?
3. **Custom tool execution** — can custom tools run arbitrary TypeScript, or only structured HTTP calls?
4. **Ollama support** — local model discovery (auto-detect running Ollama instance)?
