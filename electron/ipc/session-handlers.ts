import * as crypto from "crypto";
import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import {
  createSession,
  listSessions,
  getSession,
  deleteSession,
  saveMessage,
  updateSessionTitle,
  updateSessionModel,
  updateSessionAgent,
  updateSessionSkills,
  setDisabledMcpServers,
  getDisabledMcpServers,
} from "../sessions";
import { listProjects } from "../projects";
import { isProviderId } from "../providers";
import {
  cleanupManagedWorktree,
  createManagedWorktree,
  isGitRepo,
  resolveManagedWorktreeRoot,
} from "../worktree";
import { cancelSessionApprovals } from "../agent/approval";
import { cancelSessionQuestions } from "../agent/question";
import { cleanupCopilotSession } from "../agent/copilot";
import { getProvider } from "../agent/runner";
import { OLLAMA_NO_MODELS_ERROR } from "../agent/ollama";
import { OPENAI_COMPAT_NO_MODELS_ERROR } from "../agent/openai-compat";
import { cleanupSessionQueueState } from "./agent-handlers";
import type { Provider } from "../../src/types/index";
import { handle } from "./handle";

export function registerSessionHandlers(
  db: Database,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  handle(CH.CREATE_SESSION, async (_event, payload: { projectId: string; providerOverride?: string; issueNumber?: number }) => {
    const { projectId, issueNumber } = payload;
    // The wire type is a plain string; validate it against the canonical
    // provider ids so a buggy/compromised renderer can't slip an unknown
    // provider into getProvider()/session creation. Unknown → fall back to default.
    const providerOverride: Provider | undefined =
      payload.providerOverride && isProviderId(payload.providerOverride) ? payload.providerOverride : undefined;

    const project = listProjects(db).find((p) => p.id === projectId);
    const provider = providerOverride ?? project?.config.provider ?? null;

    // Providers without a static default model — resolve the first available
    // model at session creation so the session never starts model-less. A Map
    // (not an object) so a corrupted provider string like "toString" can't
    // match an inherited key and slip into the dynamic-model path.
    const dynamicModelErrors = new Map<string, string>([
      ["ollama", OLLAMA_NO_MODELS_ERROR],
      ["openai-compatible", OPENAI_COMPAT_NO_MODELS_ERROR],
    ]);
    const resolveDynamicModel = async (p: string): Promise<string> => {
      const models = await getProvider(p).listModels?.();
      const first = models?.[0]?.id ?? null;
      if (!first) throw new Error(dynamicModelErrors.get(p) ?? `No models available for provider "${p}"`);
      return first;
    };

    let model: string | null;
    if (providerOverride && providerOverride !== project?.config.provider) {
      if (provider === "anthropic") {
        model = "claude-sonnet-4-6";
      } else if (provider && dynamicModelErrors.has(provider)) {
        model = await resolveDynamicModel(provider);
      } else {
        model = null;
      }
    } else {
      model = project?.config.model ?? null;
      if (provider && dynamicModelErrors.has(provider) && !model?.trim()) {
        model = await resolveDynamicModel(provider);
      }
    }

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const sessionId = crypto.randomUUID();
    let branch: string | null = null;
    let workspacePath = project.path;

    if (project.config.create_worktree_per_session) {
      if (isGitRepo(project.path)) {
        const { managedRoot, warning } = resolveManagedWorktreeRoot(project.path, project.config.worktree_root_path);
        if (warning) {
          console.warn(`[worktree] ${warning}`);
          getMainWindow()?.webContents.send(CH.WORKTREE_WARNING, { message: warning });
        }

        const worktree = createManagedWorktree(project.path, sessionId, managedRoot);
        if (worktree.created) {
          branch = worktree.branch;
          workspacePath = worktree.workspacePath;
        } else if (worktree.warning) {
          console.warn(`[worktree] ${worktree.warning}`);
          getMainWindow()?.webContents.send(CH.WORKTREE_WARNING, {
            message: `Session worktree creation failed; falling back to the main checkout.\n${worktree.warning}`,
          });
        }
      } else {
        const warning = `Project is not git-backed; creating the session in the main checkout instead.`;
        console.warn(`[worktree] ${warning}`);
        getMainWindow()?.webContents.send(CH.WORKTREE_WARNING, { message: warning });
      }
    }

    return createSession(db, projectId, provider, model, {
      id: sessionId,
      branch,
      workspacePath,
      issueNumber,
    });
  });

  handle(CH.LIST_SESSIONS, (_event, projectId: string) =>
    listSessions(db, projectId)
  );
  handle(CH.GET_SESSION, (_event, sessionId: string) =>
    getSession(db, sessionId)
  );
  handle(CH.DELETE_SESSION, (_event, sessionId: string, options?: { cleanupWorktree?: boolean }) => {
    const session = getSession(db, sessionId);
    const project = listProjects(db).find((p) => p.id === session.project_id);
    if (!project) throw new Error(`Project not found for session ${sessionId}`);

    const ownsManagedWorktree =
      Boolean(session.branch) &&
      Boolean(session.workspace_path) &&
      session.workspace_path !== project.path;

    if (options?.cleanupWorktree && ownsManagedWorktree) {
      cleanupManagedWorktree({
        repoRoot: project.path,
        workspacePath: session.workspace_path ?? project.path,
        branch: session.branch ?? "",
      });
    }

    cancelSessionApprovals(sessionId);
    cancelSessionQuestions(sessionId);
    cleanupCopilotSession(sessionId);
    activeTurns.delete(sessionId);
    cleanupSessionQueueState(sessionId);
    return deleteSession(db, sessionId);
  });
  handle(
    CH.SAVE_MESSAGE,
    (_event, args: { sessionId: string; role: string; content: string }) =>
      saveMessage(db, args)
  );
  handle(
    CH.UPDATE_SESSION_TITLE,
    (_event, sessionId: string, title: string) =>
      updateSessionTitle(db, sessionId, title)
  );
  handle(
    CH.UPDATE_SESSION_MODEL,
    (_event, sessionId: string, provider: Provider, model: string) =>
      updateSessionModel(db, sessionId, provider, model)
  );
  handle(
    CH.UPDATE_SESSION_AGENT,
    (_event, sessionId: string, agent: string | null) =>
      updateSessionAgent(db, sessionId, agent)
  );
  handle(
    CH.UPDATE_SESSION_SKILLS,
    (_event, sessionId: string, skills: string[]) =>
      updateSessionSkills(db, sessionId, skills)
  );
  handle(
    CH.UPDATE_SESSION_DISABLED_MCP,
    (_event, sessionId: string, names: string[]) => {
      setDisabledMcpServers(db, sessionId, names);
      return getDisabledMcpServers(db, sessionId);
    }
  );
}
