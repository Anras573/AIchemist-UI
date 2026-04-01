import * as crypto from "crypto";
import * as CH from "../ipc-channels";

// ── Question gate ─────────────────────────────────────────────────────────────
//
// Mirrors the approval gate pattern in approval.ts.
// ask_user MCP tool suspends here until the renderer resolves the answer.

const pendingQuestions = new Map<
  string,
  { sessionId: string; resolve: (answer: string) => void }
>();

export function resolveQuestion(questionId: string, answer: string): void {
  const pending = pendingQuestions.get(questionId);
  if (pending) {
    pending.resolve(answer);
    pendingQuestions.delete(questionId);
  }
}

/** Cancels all pending questions for a session, resolving with an empty string. */
export function cancelSessionQuestions(sessionId: string): void {
  for (const [id, pending] of pendingQuestions.entries()) {
    if (pending.sessionId === sessionId) {
      pending.resolve("");
      pendingQuestions.delete(id);
    }
  }
}

/** Emits SESSION_QUESTION_REQUIRED and suspends until the user answers. */
export function requestQuestion(
  webContents: Electron.WebContents,
  sessionId: string,
  question: string,
  options?: string[],
  placeholder?: string
): Promise<string> {
  const questionId = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingQuestions.set(questionId, { sessionId, resolve });
    webContents.send(CH.SESSION_QUESTION_REQUIRED, {
      session_id: sessionId,
      question_id: questionId,
      question,
      options,
      placeholder,
    });
  });
}
