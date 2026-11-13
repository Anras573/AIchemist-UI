// @vitest-environment node
// Real-process tests for implExecuteBash (async spawn, timeout, abort, cap).
import { describe, it, expect } from "vitest";
import {
  implExecuteBash,
  cancelSessionShells,
  MAX_BASH_OUTPUT_BYTES,
} from "./tool-impls";

const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
const run = async (args: Parameters<typeof implExecuteBash>[0]) => JSON.parse(await implExecuteBash(args));

describe("implExecuteBash", () => {
  it("returns stdout, stderr and exit_code", async () => {
    const r = await run({ command: node("console.log('hi'); console.error('err'); process.exit(3)") });
    expect(r).toEqual({ stdout: "hi\n", stderr: "err\n", exit_code: 3 });
  });

  it("does not block the event loop while a command runs", async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    await run({ command: node("setTimeout(()=>{},300)") });
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(5);
  });

  it("kills the command on timeout", async () => {
    const started = Date.now();
    const r = await run({ command: node("setTimeout(()=>{},30000)"), timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toMatch(/timed out/);
  });

  it("kills the command when the AbortSignal fires", async () => {
    const ac = new AbortController();
    const p = run({ command: node("setTimeout(()=>{},30000)"), signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.exit_code).toBe(-1);
    expect(r.stderr).toMatch(/cancelled/);
  });

  it("cancelSessionShells kills that session's running commands", async () => {
    const p = run({ command: node("setTimeout(()=>{},30000)"), sessionId: "s1" });
    setTimeout(() => cancelSessionShells("s1"), 100);
    expect((await p).stderr).toMatch(/cancelled/);
  });

  it("truncates output over the cap but keeps the real exit code", async () => {
    const r = await run({
      command: node(`process.stdout.write('x'.repeat(${MAX_BASH_OUTPUT_BYTES * 2})); process.exitCode=7`),
    });
    expect(r.exit_code).toBe(7);
    expect(r.stdout.endsWith("[output truncated]")).toBe(true);
    expect(r.stdout.length).toBeLessThan(MAX_BASH_OUTPUT_BYTES + 100);
  });
});
