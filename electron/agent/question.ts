import * as crypto from "crypto";
import * as CH from "../ipc-channels";

// ── Question gate ─────────────────────────────────────────────────────────────
//
// Mirrors the approval gate pattern in approval.ts.
// ask_user MCP tool suspends here until the renderer resolves the answer.

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const pendingQuestions = new Map<
  string,
  { sessionId: string; resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> }
>();

export function resolveQuestion(questionId: string, answer: string): void {
  const pending = pendingQuestions.get(questionId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(answer);
    pendingQuestions.delete(questionId);
  }
}

/** Cancels all pending questions for a session, resolving with an empty string. */
export function cancelSessionQuestions(sessionId: string): void {
  for (const [id, pending] of pendingQuestions.entries()) {
    if (pending.sessionId === sessionId) {
      clearTimeout(pending.timer);
      pending.resolve("");
      pendingQuestions.delete(id);
    }
  }
}

/** Emits SESSION_QUESTION_REQUIRED and suspends until the user answers.
 * Auto-resolves with an empty string after 5 minutes if unanswered.
 *
 * In `nonInteractive` mode (unattended workflow runs) there is no renderer to
 * answer, so `ask_user` would hang the full timeout. Instead it logs a warning
 * and resolves immediately with an empty answer, letting the agent continue
 * (it surfaces "(no answer provided)") rather than blocking.
 */
export function requestQuestion(
  webContents: Electron.WebContents,
  sessionId: string,
  question: string,
  options?: string[],
  placeholder?: string,
  opts?: { nonInteractive?: boolean }
): Promise<string> {
  if (opts?.nonInteractive) {
    console.warn(
      `[question] session=${sessionId} ask_user resolved empty — non-interactive (unattended) turn, no user to answer`
    );
    return Promise.resolve("");
  }
  const questionId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingQuestions.has(questionId)) {
        console.warn(`[question] (${questionId}) timed out after 5 min — resolving empty`);
        pendingQuestions.delete(questionId);
        resolve("");
      }
    }, QUESTION_TIMEOUT_MS);

    pendingQuestions.set(questionId, { sessionId, resolve, timer });
    webContents.send(CH.SESSION_QUESTION_REQUIRED, {
      session_id: sessionId,
      question_id: questionId,
      question,
      options,
      placeholder,
    });
  });
}
