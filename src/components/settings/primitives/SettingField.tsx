import { useState, type ReactNode } from "react";
import { Check, AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AutosaveStatus } from "@/lib/hooks/useAutosave";

// ── Inline autosave status / undo affordance ──────────────────────────────────
interface StatusProps {
  status: AutosaveStatus;
  canUndo: boolean;
  onUndo: () => void;
}

export function SettingStatus({ status, canUndo, onUndo }: StatusProps) {
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-green-600">
          <Check className="h-3.5 w-3.5" /> Saved
        </span>
        {canUndo && (
          <button
            type="button"
            onClick={onUndo}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            Undo
          </button>
        )}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5" /> Save failed
      </span>
    );
  }
  return null;
}

// ── Field shell: label row (+ status), control, helper, error ─────────────────
interface BaseProps {
  id: string;
  label: string;
  helper?: ReactNode;
  status: AutosaveStatus;
  canUndo: boolean;
  onUndo: () => void;
  error?: Error | null;
}

function FieldShell({
  id,
  label,
  helper,
  status,
  canUndo,
  onUndo,
  error,
  inline,
  children,
}: BaseProps & { inline?: boolean; children: ReactNode }) {
  const header = (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        {label}
      </label>
      <SettingStatus status={status} canUndo={canUndo} onUndo={onUndo} />
    </div>
  );
  return (
    <div className="space-y-1.5">
      {/* Toggles render the control beside the label; other variants stack. */}
      {inline ? (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="text-sm font-medium leading-none">
            {label}
          </label>
          <div className="flex items-center gap-3">
            <SettingStatus status={status} canUndo={canUndo} onUndo={onUndo} />
            {children}
          </div>
        </div>
      ) : (
        <>
          {header}
          {children}
        </>
      )}
      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{error.message}</span>
        </p>
      )}
    </div>
  );
}

// ── Variant prop unions ───────────────────────────────────────────────────────
type TextProps = BaseProps & {
  variant: "text" | "secret";
  value: string;
  placeholder?: string;
  mono?: boolean;
  onChange: (v: string) => void;
};

type NumberProps = BaseProps & {
  variant: "number";
  value: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: string) => void;
};

type SelectProps = BaseProps & {
  variant: "select";
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
};

type ToggleProps = BaseProps & {
  variant: "toggle";
  value: boolean;
  onChange: (v: boolean) => void;
};

export type SettingFieldProps = TextProps | NumberProps | SelectProps | ToggleProps;

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Declarative settings field: label + helper + inline autosave status/undo +
 * error slot. The owning section wires `value`/`onChange` to a `useAutosave`
 * handle and passes `{ status, canUndo, onUndo, error }` from it.
 */
export function SettingField(props: SettingFieldProps) {
  const [show, setShow] = useState(false);
  const { id, label, helper, status, canUndo, onUndo, error } = props;
  const shell = { id, label, helper, status, canUndo, onUndo, error };

  if (props.variant === "toggle") {
    return (
      <FieldShell {...shell} inline>
        <button
          type="button"
          role="switch"
          id={id}
          aria-checked={props.value}
          aria-label={label}
          onClick={() => props.onChange(!props.value)}
          className={cn(
            "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            props.value ? "bg-primary" : "bg-input",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
              props.value ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </FieldShell>
    );
  }

  if (props.variant === "select") {
    return (
      <FieldShell {...shell}>
        <select
          id={id}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className={SELECT_CLASS}
        >
          {props.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </FieldShell>
    );
  }

  if (props.variant === "number") {
    return (
      <FieldShell {...shell}>
        <Input
          id={id}
          type="number"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          className="font-mono text-sm w-32"
        />
      </FieldShell>
    );
  }

  // text / secret
  const isSecret = props.variant === "secret";
  return (
    <FieldShell {...shell}>
      <div className="relative">
        <Input
          id={id}
          type={isSecret && !show ? "password" : "text"}
          value={props.value}
          placeholder={props.placeholder ?? (isSecret ? "Not set" : undefined)}
          onChange={(e) => props.onChange(e.target.value)}
          className={cn(props.mono || isSecret ? "font-mono text-sm" : "text-sm", isSecret && "pr-9")}
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
            aria-label={show ? "Hide value" : "Show value"}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </FieldShell>
  );
}
