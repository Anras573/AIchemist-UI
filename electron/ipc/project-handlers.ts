import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import { addProject, listProjects, removeProject, getProjectConfig, saveProjectConfig } from "../projects";
import { readSettings } from "../settings";
import { isProviderId } from "../providers";
import type { ProjectConfig } from "../../src/types/index";
import { handle } from "./handle";

export function registerProjectHandlers(db: Database): void {
  handle(CH.ADD_PROJECT, (_event, projectPath: string) => {
    const raw = readSettings().AICHEMIST_DEFAULT_PROVIDER;
    const defaultProvider = raw && isProviderId(raw) ? raw : "anthropic";
    return addProject(db, projectPath, defaultProvider);
  });
  handle(CH.LIST_PROJECTS, () => listProjects(db));
  handle(CH.REMOVE_PROJECT, (_event, id: string) =>
    removeProject(db, id)
  );
  handle(CH.GET_PROJECT_CONFIG, (_event, id: string) =>
    getProjectConfig(db, id)
  );
  handle(
    CH.SAVE_PROJECT_CONFIG,
    (_event, id: string, config: ProjectConfig) =>
      saveProjectConfig(db, id, config)
  );
}
