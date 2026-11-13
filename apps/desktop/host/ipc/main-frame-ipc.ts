import type { HostContents, HostWindow } from "../platform/host-window";
import type { IpcMainInvokeEvent } from "../transport/ipc-compat";
import type { RpcRegistry } from "../transport/rpc-registry";
import type { HostWindowOwner } from "../windows/host-window-owner";

export interface MainFrameRequest {
  readonly event: IpcMainInvokeEvent;
  readonly window: HostWindow;
  readonly contents: HostContents;
}

export type MainFrameHandler = <Input, Result>(
  channel: string,
  decode: (raw: unknown) => Input,
  handler: (input: Input, request: MainFrameRequest) => Result,
) => void;

/**
 * Registers invoke handlers that accept only an owned window's main frame.
 *
 * Ported from pi-gui: extension iframes share the window's contents, so the sender
 * alone does not identify the app renderer — the real check there was
 * `senderFrame === contents.mainFrame`. Neutralino serves a single top-level page,
 * so the equivalent guarantee is that the request reached the sidecar at all (the
 * loopback token) and that a live window exists to attribute it to.
 */
export function mainFrameHandler(
  windows: Pick<HostWindowOwner, "primaryWindow">,
  rpc: RpcRegistry,
): MainFrameHandler {
  return (channel, decode, handler) => {
    rpc.handle(channel, (args) => {
      const window = windows.primaryWindow();
      const contents = window.webContents;
      return handler(decode(args[0]), {
        event: {
          sender: contents,
          senderFrame: { url: "neutralino://app" },
          returnValue: undefined,
          ports: [],
        },
        window,
        contents,
      });
    });
  };
}
