import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import { readSettings, writeSettings } from "../settings";
import type { SettingsMap } from "../settings";
import { getApiKey, getAnthropicConfig } from "../config";
import { probeAll } from "../agent/provider-probe";
import { parseDisabledProviders } from "../providers";
import { getProjectConfig, listProjects } from "../projects";
import {
  deleteOpenAiEndpoint,
  readOpenAiEndpoints,
  upsertOpenAiEndpoint,
} from "../openai-endpoints";
import type { OpenAiEndpointEntry } from "../openai-endpoints";
import { _resetOpenAiCompatProbeCache } from "../agent/openai-compat";
import type { ProjectConfig } from "../../src/types/index";
import { handle } from "./handle";

export function registerSettingsHandlers(db: Database): void {
  handle(CH.SETTINGS_READ, () => readSettings());
  handle(CH.SETTINGS_WRITE, (_event, updates: Partial<SettingsMap>) =>
    writeSettings(updates)
  );
  handle(CH.GET_API_KEY, (_event, provider: string) =>
    getApiKey(provider)
  );
  handle(CH.GET_ANTHROPIC_CONFIG, () => getAnthropicConfig());
  handle(CH.PROBE_PROVIDERS, async (_event, args?: { projectId?: string; force?: boolean }) => {
    let project: { path: string; config: ProjectConfig } | undefined;
    if (args?.projectId) {
      const all = listProjects(db);
      const p = all.find((x) => x.id === args.projectId);
      if (p) {
        const cfg = getProjectConfig(db, p.id) ?? {};
        project = { path: p.path, config: cfg };
      }
    }
    const disabled = parseDisabledProviders(process.env.AICHEMIST_DISABLED_PROVIDERS);
    return probeAll(project, { force: args?.force, disabled });
  });

  handle(CH.OPENAI_ENDPOINTS_READ, () => readOpenAiEndpoints());
  handle(CH.OPENAI_ENDPOINT_UPSERT, (_event, name: string, entry: OpenAiEndpointEntry) => {
    upsertOpenAiEndpoint(name, entry);
    _resetOpenAiCompatProbeCache();
    return readOpenAiEndpoints();
  });
  handle(CH.OPENAI_ENDPOINT_DELETE, (_event, name: string) => {
    deleteOpenAiEndpoint(name);
    _resetOpenAiCompatProbeCache();
    return readOpenAiEndpoints();
  });
}
