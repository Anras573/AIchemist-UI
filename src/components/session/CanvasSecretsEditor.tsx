import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CanvasSecretStatus } from "@/types";

interface CanvasSecretsEditorProps {
  projectId: string;
  definition: string;
}

/**
 * Lets the user supply the credentials a canvas's manifest declares (#249).
 * Values are write-only: the main process only reports whether each is set,
 * and injects them into that definition's host as env vars on its next start.
 * Renders nothing for a canvas that declares no secrets.
 */
export function CanvasSecretsEditor({ projectId, definition }: CanvasSecretsEditorProps) {
  const ipc = useIpc();
  const [secrets, setSecrets] = useState<CanvasSecretStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSecrets(await ipc.canvasSecretsStatus({ projectId, definition }));
    } catch {
      setSecrets([]);
    }
  }, [ipc, projectId, definition]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (secrets.length === 0) return null;

  async function save(name: string) {
    setError(null);
    try {
      await ipc.canvasSecretSet({ projectId, definition, name, value: drafts[name] ?? "" });
      setDrafts((d) => ({ ...d, [name]: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clear(name: string) {
    setError(null);
    try {
      await ipc.canvasSecretClear({ projectId, definition, name });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-1.5 text-[11px]">
      <p className="flex items-center gap-1 font-medium text-foreground/80">
        <KeyRound className="h-3 w-3" /> Secrets this canvas needs
      </p>
      {secrets.map((s) => (
        <div key={s.name} className="space-y-0.5">
          <div className="flex items-center gap-2">
            <code>{s.name}</code>
            <span className={s.set ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
              {s.set ? "set" : "not set"}
            </span>
            {s.set && (
              <Button size="xs" variant="ghost" onClick={() => void clear(s.name)}>
                Clear
              </Button>
            )}
          </div>
          {s.description && <p className="text-muted-foreground">{s.description}</p>}
          <div className="flex gap-1.5">
            <Input
              type="password"
              autoComplete="off"
              aria-label={`Value for ${s.name}`}
              placeholder={s.set ? "Replace value…" : "Value"}
              value={drafts[s.name] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
              className="h-7 text-xs"
            />
            <Button size="xs" disabled={!drafts[s.name]} onClick={() => void save(s.name)}>
              Save
            </Button>
          </div>
        </div>
      ))}
      <p className="text-muted-foreground">Stored outside the canvas state; applied the next time the canvas starts.</p>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
