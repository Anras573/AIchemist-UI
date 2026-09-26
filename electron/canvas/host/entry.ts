/**
 * Bootstrap script for a canvas host process, forked via
 * `utilityProcess.fork()` (see `../host-manager.ts`). Not unit-tested: it only
 * exists to run inside a real `UtilityProcess`, where `process.parentPort` and
 * a real ESM loader thread are available — neither exists under vitest. Its
 * actual logic is two already-tested pieces: `loadServerModule` (`loader.ts`)
 * and `createCanvasHostRuntime` (`runtime.ts`).
 *
 * Invocation (see `CanvasHostManager.spawnHost`): `argv[2]` is the absolute
 * path to the definition's `server.mjs`, `argv[3]` is `{ id, path }` for the
 * owning project as JSON.
 */
import { register } from "node:module";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import type { HostToMainMessage } from "../host-protocol";
import { MainToHostMessageSchema } from "../host-protocol";
import { loadServerModule } from "./loader";
import { createCanvasHostRuntime, type HostTransport } from "./runtime";
import type { CanvasServerDefinition } from "./sdk";

// Makes `import { defineCanvas, z } from "@aichemist/canvas"` resolvable from
// a canvas's `server.mjs`, with no install step — see `loader-hook.ts`. Must
// run before the first dynamic `import()` of a server module below.
register(pathToFileURL(nodePath.join(__dirname, "loader-hook.js")).href);

function send(message: HostToMainMessage): void {
  process.parentPort.postMessage(message);
}

function sendInitError(error: unknown): void {
  send({ type: "init.error", error: error instanceof Error ? error.message : String(error) });
}

async function main(): Promise<void> {
  const [serverPath, projectJson] = process.argv.slice(2);
  if (!serverPath || !projectJson) {
    sendInitError("Canvas host started with no server module path / project info");
    return;
  }

  let project: { id: string; path: string };
  try {
    project = JSON.parse(projectJson) as { id: string; path: string };
  } catch (err) {
    sendInitError(err);
    return;
  }

  let definition: CanvasServerDefinition;
  try {
    definition = await loadServerModule(serverPath);
  } catch (err) {
    sendInitError(err);
    return;
  }

  const transport: HostTransport = {
    send,
    onMessage: (handler) => {
      process.parentPort.on("message", (event) => {
        const parsed = MainToHostMessageSchema.safeParse(event.data);
        if (parsed.success) handler(parsed.data);
      });
    },
  };

  createCanvasHostRuntime({ definition, transport, project });
}

// A canvas is arbitrary code — an uncaught error must reach main as a clean
// `init.error` (so it can decide whether to restart) rather than a silent
// process death `handleExit()` has to guess about.
process.on("uncaughtException", (err) => {
  sendInitError(err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  sendInitError(reason);
});

void main();
