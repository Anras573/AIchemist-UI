import { ipcMain } from "electron";
import type { ContractArgs, ContractResult, RequestChannel } from "../ipc-contract";
import { classifyError, type IpcEnvelope } from "./errors";
import { validators } from "./validators";

/**
 * Registers an `ipcMain.handle` for a contract channel. The handler's args and
 * result are type-checked against {@link IpcContract}, so they must stay
 * compatible with the channel's declared shape (this is what removed the old
 * `any` signature). Note TypeScript still permits a handler to *widen* a
 * parameter (e.g. `Provider` → `string`) and remain assignable, so keep handler
 * signatures exact to the contract to catch that kind of drift.
 *
 * Every handler resolves to an {@link IpcEnvelope}: a thrown error is caught,
 * logged, and returned as `{ ok: false, error: { code, message } }` rather than
 * collapsed to a bare message string — so the renderer can branch on `code`.
 * Mutation channels are validated (zod) before the handler runs.
 */
export function handle<C extends RequestChannel>(
  channel: C,
  handler: (
    event: Electron.IpcMainInvokeEvent,
    ...args: ContractArgs<C>
  ) => ContractResult<C> | Promise<ContractResult<C>>
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcEnvelope<ContractResult<C>>> => {
    try {
      validators[channel]?.(args);
      const data = await handler(event, ...(args as ContractArgs<C>));
      return { ok: true, data };
    } catch (err) {
      console.error(`[IPC] "${channel}" failed:`, err);
      return { ok: false, error: classifyError(err) };
    }
  });
}
