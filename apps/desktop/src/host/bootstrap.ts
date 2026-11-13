/**
 * Renderer bootstrap: everything Electron's main process did for `window.piApp`,
 * reduced to "start the sidecar, wire the bridge, then run the app".
 *
 * The ordering matters and mirrors Electron's: `window.piApp` must exist before the
 * React tree renders, because components read it during their first render.
 */
import { attachAccelerators } from "./accelerators";
import { createPiAppBridge } from "./bridge";
import { hasNeutralino, neutralino } from "./neutralino";
import { shellTranslator } from "./shell-locale";
import { handleSidecarRequests } from "./renderer-requests";
import { startSidecar, type RunningSidecar } from "./sidecar-process";
import { HostTransport } from "./transport";
import { installWindowDrag } from "./window-drag";
import { attachWindowState, drawsWindowControls } from "./window-state";

/**
 * Injected by Vite. In a packaged build the sidecar is a compiled binary next to the
 * app; in dev it runs from source so the host code hot-restarts with the app.
 */
declare const __PI_SIDECAR_DEV__: boolean;
declare const __PI_SIDECAR_DEV_COMMAND__: string;
declare const __PI_SIDECAR_DEV_CWD__: string;

const SYSTEM_THEME_CHANNEL = "pi-gui:system-theme";

interface NeutralinoGlobals {
  readonly NL_PATH?: string;
  readonly NL_OS?: string;
  readonly NL_CVERSION?: string;
}

function globals(): NeutralinoGlobals {
  return globalThis as unknown as NeutralinoGlobals;
}

function platformId(): string {
  switch (globals().NL_OS) {
    case "Windows":
      return "win32";
    case "Darwin":
      return "darwin";
    default:
      return "linux";
  }
}

/** Neutralino spawns through a shell, so a path with spaces must be quoted. */
function quoteCommand(command: string): string {
  return command.includes(" ") ? `"${command}"` : command;
}

function resolveSidecarCommand(): { command: string; cwd?: string } {
  if (__PI_SIDECAR_DEV__) {
    return {
      command: __PI_SIDECAR_DEV_COMMAND__,
      ...(__PI_SIDECAR_DEV_CWD__ ? { cwd: __PI_SIDECAR_DEV_CWD__ } : {}),
    };
  }
  const root = globals().NL_PATH ?? ".";
  return { command: quoteCommand(`${root}/binaries/pi-lucky-sidecar.exe`) };
}

function showFatalError(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  console.error("[bootstrap] fatal", error);
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.style.cssText =
    "font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:32px;white-space:pre-wrap;color:#e5484d";
  panel.textContent = `${shellTranslator()("shell.startupFailed")}\n\n${message}`;
  root.append(panel);
}

/** Report the OS colour scheme so the sidecar resolves the same theme the CSS does. */
function reportSystemTheme(transport: HostTransport): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const report = () => {
    void transport.invoke(SYSTEM_THEME_CHANNEL, [query.matches]).catch(() => undefined);
  };
  query.addEventListener("change", report);
  report();
  return () => query.removeEventListener("change", report);
}

export async function bootstrap(): Promise<void> {
  if (!hasNeutralino()) {
    throw new Error(
      "The Neutralino runtime is missing. Load js/neutralino.js before the app bundle.",
    );
  }

  const api = neutralino();
  api.init();

  const { command, cwd } = resolveSidecarCommand();
  const sidecar: RunningSidecar = await startSidecar({
    command,
    ...(cwd ? { cwd } : {}),
    onLog: (line, stream) => {
      console[stream === "stderr" ? "error" : "log"]("[sidecar]", line);
    },
    onExit: () => {
      // The sidecar owns all session state: without it the UI can do nothing, so a
      // dead process is shown rather than leaving an inert window behind.
      showFatalError(new Error(shellTranslator()("shell.sidecarStopped")));
    },
  });

  const transport = new HostTransport({
    origin: `http://127.0.0.1:${sidecar.endpoint.port}`,
    token: sidecar.endpoint.token,
  });
  await transport.connect();

  const windowState = await attachWindowState(transport);
  const bridge = createPiAppBridge({
    transport,
    platform: platformId(),
    drawsWindowControls: drawsWindowControls(),
    versions: {
      neutralino: globals().NL_CVERSION ?? "",
      sidecar: sidecar.endpoint.version,
      bun: navigator.userAgent,
    } as unknown as Record<string, string>,
    isMaximized: windowState.isMaximized,
    setMaximized: windowState.setMaximized,
  });

  window.piApp = bridge.api;
  handleSidecarRequests(transport);
  installWindowDrag();
  reportSystemTheme(transport);
  attachAccelerators({
    platform: bridge.api.platform,
    pickWorkspace: () => {
      void bridge.api.pickWorkspace().catch((error: unknown) => {
        console.error("[bootstrap] pickWorkspace failed", error);
      });
    },
    readClipboardImage: async () => bridge.api.readClipboardImage(),
    emitPush: (channel, payload) => bridge.emitLocalPush(channel, payload),
  });

  // Closing the window must stop the sidecar even if `app.exit` races the process.
  window.addEventListener("beforeunload", () => {
    windowState.dispose();
    transport.dispose();
    void sidecar.stop();
  });

  await import("../main");
}

void bootstrap().catch(showFatalError);
