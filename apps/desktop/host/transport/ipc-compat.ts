/**
 * Compatibility seam for the ported pi-gui IPC layer.
 *
 * `ipc/register-desktop-ipc.ts` is 1,185 lines of request decoding and store calls
 * that have nothing to do with Electron — only its entry points do. Instead of
 * rewriting 100 handlers (and inviting drift from upstream), this module provides
 * the three Electron names that file imports, backed by the sidecar's own pieces:
 *
 *   ipcMain.handle(channel, listener)  → RpcRegistry over HTTP
 *   ipcMain.on(channel, listener)      → RpcRegistry, fire-and-forget
 *   shell.openPath(path)               → the OS shell, from the sidecar process
 *
 * Sender validation is preserved in spirit: this app serves exactly one window, so
 * each request resolves to that window's contents, and a request that arrives
 * before the renderer attached fails loudly rather than using a stale window.
 */
import path from "node:path";
import type { HostContents, HostWindow } from "../platform/host-window";
import type { RpcRegistry } from "./rpc-registry";

export type BrowserWindow = HostWindow;
export type WebContents = HostContents;

/** The sender identity `register-desktop-ipc.ts` reads off each request. */
export interface IpcMainInvokeEvent {
  readonly sender: HostContents;
  readonly senderFrame: { readonly url: string };
  /** Only `sendSync` channels use this; those are renderer-local in pi-lucky. */
  returnValue: unknown;
  readonly ports: readonly never[];
}

export interface IpcCompatibilityHost {
  readonly rpc: RpcRegistry;
  /** The window a request is attributed to; throws while no renderer is attached. */
  primaryWindow(): HostWindow;
}

let host: IpcCompatibilityHost | null = null;

export function configureIpcCompat(next: IpcCompatibilityHost): void {
  host = next;
}

function requireHost(): IpcCompatibilityHost {
  if (!host) {
    throw new Error("ipc compatibility layer used before the sidecar bootstrapped it");
  }
  return host;
}

function senderContext(): IpcMainInvokeEvent {
  const window = requireHost().primaryWindow();
  return {
    sender: window.webContents,
    senderFrame: { url: "neutralino://app" },
    returnValue: undefined,
    ports: [],
  };
}

function notFoundMessage(target: string): string {
  return `The OS did not open ${target}`;
}

/** Launch a file, folder or URL through the OS's registered handlers. */
export async function openWithOsShell(target: string): Promise<void> {
  const command =
    process.platform === "win32" ? ["cmd", "/c", "start", "", target] : ["open", target];
  const child = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(stderr.trim() || notFoundMessage(target));
  }
}

export const ipcMain = {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown,
  ): void {
    requireHost().rpc.handle(channel, (args) => listener(senderContext(), ...(args as never[])));
  },
  on(channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => void): void {
    requireHost().rpc.handle(channel, (args) => {
      listener(senderContext(), ...(args as never[]));
      return undefined;
    });
  },
  /** Sync channels are served by the renderer bridge; registration is accepted and ignored. */
  handleOnce(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): void {
    ipcMain.handle(channel, listener);
  },
};

export const shell = {
  openPath: async (target: string) => {
    await openWithOsShell(target);
    return "";
  },
  showItemInFolder: async (target: string) => {
    if (process.platform === "win32") {
      Bun.spawn({
        cmd: ["explorer.exe", `/select,${path.resolve(target)}`],
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    }
    await openWithOsShell(path.dirname(path.resolve(target)));
  },
  openExternal: (url: string) => openWithOsShell(url),
};
