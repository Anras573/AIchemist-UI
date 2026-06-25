import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Project } from "@/types";

/**
 * Identifies which section of the Settings hub is active. `scope` selects the
 * application-wide vs. active-project tier; `id` names the section within that
 * tier (so deep links can target a specific section).
 */
export interface SettingsSection {
  scope: "app" | "project";
  id: string;
}

const DEFAULT_SETTINGS_SECTION: SettingsSection = { scope: "app", id: "api-keys" };

interface ProjectStore {
  projects: Project[];
  activeProjectId: string | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  workflowsOpen: boolean;
  setProjects: (projects: Project[]) => void;
  setActiveProject: (id: string | null) => void;
  addProject: (project: Project) => void;
  removeProject: (id: string) => void;
  updateProject: (project: Project) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openWorkflows: () => void;
  closeWorkflows: () => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      projects: [],
      activeProjectId: null,
      settingsOpen: false,
      settingsSection: DEFAULT_SETTINGS_SECTION,
      workflowsOpen: false,

      setProjects: (projects) => set({ projects }),

      setActiveProject: (id) => set({ activeProjectId: id }),

      addProject: (project) =>
        set((state) => ({ projects: [...state.projects, project] })),

      removeProject: (id) =>
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
        })),

      updateProject: (project) =>
        set((state) => ({
          projects: state.projects.map((p) => (p.id === project.id ? project : p)),
        })),

      openSettings: (section) =>
        set({
          settingsOpen: true,
          workflowsOpen: false,
          ...(section ? { settingsSection: section } : {}),
        }),
      closeSettings: () => set({ settingsOpen: false }),
      setSettingsSection: (section) => set({ settingsSection: section }),
      // Workflows is a full-screen view, mutually exclusive with Settings.
      openWorkflows: () => set({ workflowsOpen: true, settingsOpen: false }),
      closeWorkflows: () => set({ workflowsOpen: false }),
    }),
    {
      name: "aichemist-project-store",
      // Only persist the active project selection — the project list itself
      // comes from SQLite (the source of truth), so we don't persist it.
      partialize: (state) => ({ activeProjectId: state.activeProjectId }),
    }
  )
);
