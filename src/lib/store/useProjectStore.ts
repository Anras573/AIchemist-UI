import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Project } from "@/types";

interface ProjectStore {
  projects: Project[];
  activeProjectId: string | null;
  settingsOpen: boolean;
  setProjects: (projects: Project[]) => void;
  setActiveProject: (id: string | null) => void;
  addProject: (project: Project) => void;
  removeProject: (id: string) => void;
  updateProject: (project: Project) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      projects: [],
      activeProjectId: null,
      settingsOpen: false,

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

      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
    }),
    {
      name: "aichemist-project-store",
      // Only persist the active project selection — the project list itself
      // comes from SQLite (the source of truth), so we don't persist it.
      partialize: (state) => ({ activeProjectId: state.activeProjectId }),
    }
  )
);
