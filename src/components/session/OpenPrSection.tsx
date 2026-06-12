import { useState, useEffect, useId, useRef, type FormEvent } from "react";
import {
  GitPullRequest,
  Loader2,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { IPC_CHANNELS, onSessionEvent, useIpc } from "@/lib/ipc";
import type { Message, SessionDeltaEvent, SessionStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const DEFAULT_PR_DESCRIPTION_HISTORY_LIMIT = 10;
const PR_DESCRIPTION_HISTORY_LIMIT_STORAGE_KEY = "aichemist.prDescriptionHistoryLimit";
const MAX_PR_DESCRIPTION_HISTORY_LIMIT = 50;
// Keeps prompt payload bounded to avoid large-diff UI churn and provider request failures.
const MAX_PR_DESCRIPTION_DIFF_CHARS = 30_000;
const PR_TEMPLATE_CANDIDATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatRecentMessages(messages: Message[], count: number): string {
  if (messages.length === 0) return "(no prior messages)";
  return messages
    .slice(-count)
    .map((message, index) => `Message ${index + 1} (${message.role}):\n${message.content}`)
    .join("\n\n");
}

function parseGeneratedPrDraft(raw: string): { title: string | null; body: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { title: null, body: "" };

  const lines = trimmed.split("\n");

  // Scan for the first "Title:" marker — ignore any model preamble before it.
  // Also accept markdown-heading variants like "## Title:" or "### Title:".
  const titleLineIndex = lines.findIndex((l) => /^(?:#+\s*)?title\s*:/i.test(l.trim()));
  if (titleLineIndex === -1) return { title: null, body: trimmed };

  const title = (lines[titleLineIndex]?.trim() ?? "")
    .replace(/^(?:#+\s*)?title\s*:\s*/i, "")
    .trim();

  // Skip blank lines after the title, then consume a "Body:" marker if present.
  // Also accept markdown-heading variants like "## Body:" or "### Body:".
  let bodyStartIndex = titleLineIndex + 1;
  while (bodyStartIndex < lines.length && (lines[bodyStartIndex] ?? "").trim() === "") {
    bodyStartIndex += 1;
  }
  if (/^(?:#+\s*)?body\s*:/i.test((lines[bodyStartIndex] ?? "").trim())) {
    bodyStartIndex += 1;
  }
  const body = lines.slice(bodyStartIndex).join("\n").trim();

  return { title: title || null, body };
}

function truncateForPrompt(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

async function readPullRequestTemplate(ipc: ReturnType<typeof useIpc>, projectPath: string): Promise<string | null> {
  for (const relativePath of PR_TEMPLATE_CANDIDATE_PATHS) {
    const result = await ipc.readFile(`${projectPath}/${relativePath}`);
    if ("content" in result && result.content.trim()) return result.content;
  }
  return null;
}

export function OpenPrSection({
  projectPath,
  sessionTitle,
  activeSessionId,
  activeSessionAgent,
  sessionMessages,
  sessionStatus,
}: {
  projectPath: string;
  sessionTitle: string | null;
  activeSessionId: string | null;
  activeSessionAgent: string | null;
  sessionMessages: Message[];
  sessionStatus: SessionStatus | undefined;
}) {
  const ipc = useIpc();
  const formId = useId();
  const titleInputId = `${formId}-pr-title`;
  const baseInputId = `${formId}-pr-base`;
  const headInputId = `${formId}-pr-head`;
  const descriptionInputId = `${formId}-pr-description`;

  const [isChecking, setIsChecking] = useState(true);
  const [hasGitHubToken, setHasGitHubToken] = useState(false);
  const [hasGitHubRemote, setHasGitHubRemote] = useState(false);
  const [defaultBaseBranch, setDefaultBaseBranch] = useState<string | null>(null);
  const [defaultHeadBranch, setDefaultHeadBranch] = useState<string | null>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const cancelGenerateRef = useRef(false);
  const initialDescriptionRef = useRef("");
  const generatedDescriptionRef = useRef("");
  const streamUnsubscribeRef = useRef<(() => void) | null>(null);
  const generateInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setIsChecking(true);

    void (async () => {
      try {
        const token = await ipc.getApiKey("github");
        if (cancelled) return;
        const hasToken = Boolean(token);
        setHasGitHubToken(hasToken);

        if (!hasToken) {
          setHasGitHubRemote(false);
          setDefaultBaseBranch(null);
          setDefaultHeadBranch(null);
          return;
        }

        const context = await ipc.githubGetPrContext({ projectPath });
        if (cancelled) return;
        setHasGitHubRemote(context.hasRemote);
        setDefaultBaseBranch(context.defaultBase);

        if (context.hasRemote) {
          const currentBranch = await ipc.getGitBranch(projectPath);
          if (cancelled) return;
          setDefaultHeadBranch(currentBranch);
        } else {
          setDefaultHeadBranch(null);
        }
      } catch {
        if (cancelled) return;
        setHasGitHubToken(false);
        setHasGitHubRemote(false);
        setDefaultBaseBranch(null);
        setDefaultHeadBranch(null);
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ipc, projectPath]);

  useEffect(() => {
    if (!successToast) return;
    const timeout = window.setTimeout(() => setSuccessToast(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [successToast]);

  useEffect(() => {
    return () => {
      cancelGenerateRef.current = true;
      streamUnsubscribeRef.current?.();
      streamUnsubscribeRef.current = null;
    };
  }, []);

  const visible = !isChecking && hasGitHubToken && hasGitHubRemote;
  if (!visible) return null;

  const openForm = () => {
    setTitle(sessionTitle ?? "");
    setBase(defaultBaseBranch ?? "");
    setHead(defaultHeadBranch ?? "");
    setDescription("");
    setError(null);
    setGenerateError(null);
    setCreatedPrUrl(null);
    setIsOpen(true);
  };

  const closeForm = () => {
    cancelGenerateRef.current = true;
    streamUnsubscribeRef.current?.();
    streamUnsubscribeRef.current = null;
    setIsOpen(false);
    setIsSubmitting(false);
    setIsGenerating(false);
  };

  const canSubmit = title.trim().length > 0 && head.trim().length > 0 && !isSubmitting && !isGenerating;
  const sessionIsBusy = sessionStatus === "running" || sessionStatus === "waiting_approval";
  const canGenerate = !isSubmitting && !isGenerating && Boolean(activeSessionId) && !sessionIsBusy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setCreatedPrUrl(null);
    setIsSubmitting(true);

    try {
      const result = await ipc.githubCreatePr({
        projectPath,
        title: title.trim(),
        body: description.trim() ? description.trim() : undefined,
        head: head.trim(),
        base: base.trim() ? base.trim() : undefined,
      });

      if ("error" in result) {
        setError(result.error);
        return;
      }

      setCreatedPrUrl(result.pr.html_url);
      setSuccessToast(`Pull request #${result.pr.number} created`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelGeneration = () => {
    cancelGenerateRef.current = true;
    streamUnsubscribeRef.current?.();
    streamUnsubscribeRef.current = null;
    setDescription(initialDescriptionRef.current);
    setIsGenerating(false);
    setGenerateError(null);
  };

  const generateDescription = async () => {
    if (generateInFlightRef.current) {
      setGenerateError("A generation is still in progress. Please wait for it to complete.");
      return;
    }
    generateInFlightRef.current = true;
    let lockedUi = false;
    try {
      if (!activeSessionId) {
        setGenerateError("Select an active session before generating a PR description.");
        return;
      }
      if (sessionStatus === "running" || sessionStatus === "waiting_approval") {
        setGenerateError("Cannot generate while the session is busy. Wait for the current turn to finish.");
        return;
      }

      setGenerateError(null);
      setError(null);

      // Lock UI immediately — before any async work — so the user cannot submit
      // or edit the description while the prompt is being assembled.
      initialDescriptionRef.current = description;
      generatedDescriptionRef.current = "";
      cancelGenerateRef.current = false;
      setDescription("");
      setIsGenerating(true);
      lockedUi = true;

      let gitDiffText: string;
      let pullRequestTemplate: string | null;
      try {
        const gitDiffResult = await ipc.getGitDiff(projectPath);
        if (cancelGenerateRef.current) return;
        if (typeof gitDiffResult !== "string") {
          setGenerateError(gitDiffResult.error);
          return;
        }
        gitDiffText = gitDiffResult;
        pullRequestTemplate = await readPullRequestTemplate(ipc, projectPath);
        if (cancelGenerateRef.current) return;
      } catch (e) {
        if (!cancelGenerateRef.current) setGenerateError(e instanceof Error ? e.message : String(e));
        return;
      }

      const historyLimit = Math.min(
        parsePositiveInt(window.localStorage.getItem(PR_DESCRIPTION_HISTORY_LIMIT_STORAGE_KEY))
          ?? DEFAULT_PR_DESCRIPTION_HISTORY_LIMIT,
        MAX_PR_DESCRIPTION_HISTORY_LIMIT
      );
      const recentMessages = formatRecentMessages(sessionMessages, historyLimit);
      const { text: gitDiffForPrompt, truncated: isDiffTruncated } = truncateForPrompt(
        gitDiffText,
        MAX_PR_DESCRIPTION_DIFF_CHARS
      );
      const diffLabel = isDiffTruncated
        ? `Project diff (git diff HEAD, truncated to ${MAX_PR_DESCRIPTION_DIFF_CHARS} chars):`
        : "Project diff (git diff HEAD):";
      const diffTruncationNote = isDiffTruncated
        ? `\n\nNOTE: Diff was truncated from ${gitDiffText.length} chars.`
        : "";

      const prompt = [
        "System instruction: Draft a concise pull request title and markdown body.",
        "Return plain markdown in this exact shape:",
        "Title: <concise PR title>",
        "",
        "Body:",
        "<markdown body suitable for the PR description field>",
        pullRequestTemplate
          ? `Follow this pull request template structure exactly (keep headings):\n\n${pullRequestTemplate}`
          : "No pull request template was found. Use a short summary and concise bullet points.",
        `Recent conversation messages (last ${historyLimit}):\n\n${recentMessages}`,
        `${diffLabel}
\n\`\`\`diff\n${gitDiffForPrompt}
\`\`\`${diffTruncationNote}`,
      ].join("\n\n---\n\n");

      streamUnsubscribeRef.current?.();
      streamUnsubscribeRef.current = onSessionEvent<SessionDeltaEvent>(IPC_CHANNELS.SESSION_DELTA, (payload) => {
        if (payload.session_id !== activeSessionId || cancelGenerateRef.current) return;
        generatedDescriptionRef.current += payload.text_delta;
        setDescription(generatedDescriptionRef.current);
      });

      try {
        await ipc.agentSend({
          sessionId: activeSessionId,
          prompt,
          agent: activeSessionAgent ?? undefined,
          skipPersistence: true,
        });
        if (!cancelGenerateRef.current) {
          const { title: generatedTitle, body } = parseGeneratedPrDraft(generatedDescriptionRef.current);
          if (generatedTitle) setTitle(generatedTitle);
          // Intentionally allow empty body to clear streamed Title/Body contract text from the textarea.
          setDescription(body);
        }
      } catch (e) {
        if (!cancelGenerateRef.current) {
          setGenerateError(e instanceof Error ? e.message : String(e));
          setDescription(initialDescriptionRef.current);
        }
      } finally {
        streamUnsubscribeRef.current?.();
        streamUnsubscribeRef.current = null;
        if (!cancelGenerateRef.current) setIsGenerating(false);
        lockedUi = false;
      }
    } finally {
      generateInFlightRef.current = false;
      // If the UI was locked but the inner try/finally never ran (prompt assembly
      // failed or was cancelled before agentSend), clean up isGenerating and restore
      // the description the user had before clicking Generate.
      if (lockedUi && !cancelGenerateRef.current) {
        setIsGenerating(false);
        setDescription(initialDescriptionRef.current);
      }
    }
  };

  const openCreatedPr = async () => {
    if (!createdPrUrl) return;
    try {
      await ipc.openGitHubUrl(createdPrUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Pull Request
        </span>
      </div>

      {!isOpen ? (
        <Button
          variant="outline"
          size="sm"
          onClick={openForm}
          className="self-start"
          aria-label="Open PR form"
        >
          <GitPullRequest className="h-3.5 w-3.5" />
          Open PR
        </Button>
      ) : (
        <form className="flex flex-col gap-2 border rounded-md p-3 bg-muted/20" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <label htmlFor={titleInputId} className="text-xs text-muted-foreground">
              Title
            </label>
            <Input
              id={titleInputId}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="PR title"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={baseInputId} className="text-xs text-muted-foreground">
                Base branch
              </label>
              <Input
                id={baseInputId}
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="Auto-detect if empty"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={headInputId} className="text-xs text-muted-foreground">
                Head branch
              </label>
              <Input
                id={headInputId}
                value={head}
                onChange={(e) => setHead(e.target.value)}
                placeholder="feature-branch"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={descriptionInputId} className="text-xs text-muted-foreground">
                Description
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!isGenerating && !canGenerate}
                onClick={isGenerating ? cancelGeneration : generateDescription}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Cancel
                  </>
                ) : (
                  "✨ Generate"
                )}
              </Button>
            </div>
            <Textarea
              id={descriptionInputId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional PR description"
              readOnly={isGenerating}
            />
          </div>

          {generateError && (
            <p className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1">{generateError}</p>
          )}

          {!head.trim() && (
            <p className="text-xs text-amber-300">
              Could not detect the current branch. Enter the head branch to continue.
            </p>
          )}

          {error && <p className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1">{error}</p>}

          {createdPrUrl && (
            <div className="text-xs rounded border border-emerald-800/60 bg-emerald-950/25 px-2 py-1.5 flex items-center justify-between gap-2">
              <span className="truncate text-emerald-300">{createdPrUrl}</span>
              <button
                type="button"
                onClick={openCreatedPr}
                className="inline-flex items-center gap-1 text-emerald-200 hover:text-emerald-100 underline underline-offset-2"
              >
                Open
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create PR"
              )}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
              Close
            </Button>
          </div>
        </form>
      )}

      {successToast && (
        <div className="fixed right-4 bottom-4 z-50 px-3 py-2 text-xs rounded-md bg-emerald-950 text-emerald-100 border border-emerald-800 shadow-lg flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {successToast}
        </div>
      )}
    </div>
  );
}
