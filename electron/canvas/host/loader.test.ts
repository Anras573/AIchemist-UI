import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadServerModule } from "./loader";

async function writeTempModule(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-loader-test-"));
  const file = path.join(dir, `server-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(file, source, "utf8");
  return file;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadServerModule", () => {
  it("returns the module's default export", async () => {
    const file = await writeTempModule(`export default { initialState: { ok: true }, tools: {} };`);
    tempDirs.push(path.dirname(file));

    const definition = await loadServerModule(file);
    expect(definition).toEqual({ initialState: { ok: true }, tools: {} });
  });

  it("throws when the module has no default export", async () => {
    const file = await writeTempModule(`export const notDefault = { tools: {} };`);
    tempDirs.push(path.dirname(file));

    await expect(loadServerModule(file)).rejects.toThrow(/no default export/);
  });

  it("throws when the default export isn't an object", async () => {
    const file = await writeTempModule(`export default "not a definition";`);
    tempDirs.push(path.dirname(file));

    await expect(loadServerModule(file)).rejects.toThrow(/no default export/);
  });

  it("propagates an error thrown while evaluating the module", async () => {
    const file = await writeTempModule(`throw new Error("bad server module");`);
    tempDirs.push(path.dirname(file));

    await expect(loadServerModule(file)).rejects.toThrow(/bad server module/);
  });

  it("throws for a module path that doesn't exist", async () => {
    await expect(loadServerModule("/nonexistent/server.mjs")).rejects.toThrow();
  });
});
