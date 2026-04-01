// Local type definitions that mirror the subset of 'ai' (Vercel AI SDK) types
// used by the ai-elements components. Defined here so the project does not need
// 'ai' as a dependency (this app drives AI state via Electron IPC + Zustand,
// not the Vercel AI SDK).

export type ToolUIPartState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-denied"
  | "output-error";

export interface ToolUIPart {
  type: `tool-${string}`;
  state: ToolUIPartState;
  input: unknown;
  output: unknown;
  errorText?: string;
}

export interface DynamicToolUIPart {
  type: "dynamic-tool";
  state: ToolUIPartState;
  toolName: string;
  input: unknown;
  output: unknown;
  errorText?: string;
}

export interface UIMessagePart {
  type: string;
  text?: string;
}

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "data";
  content: string;
  parts: UIMessagePart[];
}

export interface FileUIPart {
  type: "file";
  url: string;
  mediaType?: string;
  filename?: string;
}

export interface SourceDocumentUIPart {
  type: "source-document";
  [key: string]: unknown;
}

export type ChatStatus = "submitted" | "streaming" | "error" | "ready";
