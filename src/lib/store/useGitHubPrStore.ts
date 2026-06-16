import { create } from "zustand";

/**
 * Session-scoped "Open PR" form state.
 *
 * The PR form (open/closed + the title/base/head/description fields) used to be
 * a pile of `useState` hooks inside `OpenPrSection`, which meant the in-progress
 * draft was thrown away the moment the user switched sessions and recreated
 * blank on return. Keying the form by `sessionId` here lets each session keep
 * its own draft, so switching away and back restores exactly what was typed —
 * and a brand-new session starts clean (issue #57).
 *
 * Only the durable form fields live here. Transient, operation-bound flags
 * (submitting / generating / errors / created-PR URL) stay as local component
 * state since they are tied to in-flight work and the component's refs.
 */

export interface PrFormState {
  isOpen: boolean;
  title: string;
  base: string;
  head: string;
  description: string;
}

export const EMPTY_PR_FORM: PrFormState = {
  isOpen: false,
  title: "",
  base: "",
  head: "",
  description: "",
};

interface GitHubPrStore {
  /** Per-session form state. Absent keys fall back to {@link EMPTY_PR_FORM}. */
  forms: Record<string, PrFormState>;
  setForm: (sessionId: string, patch: Partial<PrFormState>) => void;
  resetForm: (sessionId: string) => void;
}

export const useGitHubPrStore = create<GitHubPrStore>((set) => ({
  forms: {},
  setForm: (sessionId, patch) =>
    set((state) => ({
      forms: {
        ...state.forms,
        [sessionId]: { ...(state.forms[sessionId] ?? EMPTY_PR_FORM), ...patch },
      },
    })),
  resetForm: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.forms)) return state;
      const next = { ...state.forms };
      delete next[sessionId];
      return { forms: next };
    }),
}));
