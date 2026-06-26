import type { ReactNode } from "react";

interface SettingsSectionProps {
  title: string;
  description?: ReactNode;
  /** Right-aligned header slot — e.g. an inline autosave status / undo affordance. */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * Wraps a settings section with a consistent title + description header and a
 * uniform vertical rhythm for its fields. Sections compose `<SettingField>`s
 * (and the occasional bespoke control) inside it.
 */
export function SettingsSection({ title, description, action, children }: SettingsSectionProps) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold leading-none">{title}</h2>
          {action}
        </div>
        {description &&
          // A plain string is rendered as a paragraph; a rich node goes in a
          // div to avoid invalid nested <p> when callers pass block elements.
          (typeof description === "string" ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : (
            <div className="text-sm text-muted-foreground">{description}</div>
          ))}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}
