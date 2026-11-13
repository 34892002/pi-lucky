/**
 * The renderer's half of window management.
 *
 * The sidecar keeps the same window bookkeeping pi-gui had (which window is focused,
 * which session it shows, whether it may receive pushes) but cannot see the native
 * window — only the webview can. So the renderer reports state changes and performs
 * the window commands the sidecar asks for.
 */
import { neutralino } from "./neutralino";
import type { HostTransport } from "./transport";

const WINDOW_STATE_CHANNEL = "pi-gui:window-state";
const WINDOW_COMMAND_CHANNEL = "pi-gui:window-command";

export interface WindowStateController {
  readonly isMaximized: () => boolean;
  readonly setMaximized: (maximized: boolean) => void;
  readonly isVisible: () => boolean;
  dispose(): void;
}

export async function attachWindowState(transport: HostTransport): Promise<WindowStateController> {
  const api = neutralino();
  let maximized = await api.window.isMaximized().catch(() => false);
  let focused = true;
  let visible = true;

  const report = () => {
    void transport
      .invoke(WINDOW_STATE_CHANNEL, [{ focused, minimized: false, visible, maximized }])
      .catch(() => undefined);
  };

  const subscriptions: { name: string; handler: () => void }[] = [];
  const on = async (name: string, handler: () => void) => {
    subscriptions.push({ name, handler });
    await api.events.on(name, handler);
  };

  await on("windowFocus", () => {
    focused = true;
    report();
  });
  await on("windowBlur", () => {
    focused = false;
    report();
  });
  await on("windowMaximize", () => {
    maximized = true;
    report();
  });
  await on("windowRestore", () => {
    maximized = false;
    report();
  });
  await on("windowShow", () => {
    visible = true;
    report();
  });
  await on("windowHide", () => {
    visible = false;
    report();
  });

  const unsubscribeCommands = transport.subscribe(WINDOW_COMMAND_CHANNEL, (payload) => {
    const command = typeof payload === "string" ? payload : "";
    switch (command) {
      case "maximize":
        void api.window.maximize();
        break;
      case "unmaximize":
        void api.window.unmaximize();
        break;
      case "minimize":
        void api.window.minimize();
        break;
      case "restore":
        void api.window.unminimize().catch(() => api.window.show());
        break;
      case "show":
        void api.window.show();
        break;
      case "focus":
        void api.window.focus();
        break;
      case "close":
        void api.app.exit();
        break;
      default:
        break;
    }
  });

  report();

  return {
    isMaximized: () => maximized,
    setMaximized: (value: boolean) => {
      maximized = value;
      report();
    },
    isVisible: () => visible,
    dispose: () => {
      unsubscribeCommands();
      for (const { name, handler } of subscriptions) {
        void api.events.off(name, handler).catch(() => undefined);
      }
    },
  };
}

/** Neutralino renders its own frame, so the app draws titlebar buttons itself. */
export function drawsWindowControls(): boolean {
  return true;
}
