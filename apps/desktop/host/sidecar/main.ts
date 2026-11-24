/**
 * Sidecar entry point: the process that used to be Electron's main.
 *
 * Lifecycle:
 *   1. resolve the data dir and mint a per-launch bearer token
 *   2. boot the (unchanged) DesktopAppStore
 *   3. register every ported IPC channel on an RPC registry
 *   4. listen on 127.0.0.1, then print one `PI_LUCKY_READY {...}` line
 *   5. exit when the shell goes away (stdin closes) or is asked to quit
 *
 * The renderer reads that stdout line to learn the port and token — no fixed port,
 * no credential on disk, and a stale sidecar can never be mistaken for this launch.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DesktopAppStore } from "../application/app-store";
import {
  ENV,
  initialWorkspacePaths,
  isPackaged,
  resolveUserDataDir,
} from "../env";
import { DesktopExtensionViewOwner } from "../extensions/extension-view-owner";
import { performExtensionViewHostAction } from "../extensions/extension-view-actions";
import { registerDesktopIpc } from "../ipc/register-desktop-ipc";
import { testCustomProviderModel } from "./custom-provider-model-test";
import { probeCustomProviderModels } from "./custom-provider-model-probe";
import { getChangedFiles, getFileDiff, stageFile } from "../platform/files/app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "../platform/files/app-store-files";
import { resolveExistingWorkspacePath } from "../platform/files/workspace-paths";
import { EditorService } from "../platform/editors/editor-service";
import { configureNotificationSink, nativeTheme } from "../platform/native-shell";
import { NotificationManager } from "../platform/notification-manager";
import { NotificationPermissionService } from "../platform/notification-permission";
import { TerminalService } from "../platform/terminal-service";
import { ThemeManager } from "../platform/theme-manager";
import { APP_VERSION } from "../platform/app-version";
import { TurnCheckpointStore } from "../workbench/checkpoint-store";
import { ReviewOwner } from "../workbench/review-owner";
import { configureIpcCompat, shell } from "../transport/ipc-compat";
import { PushBus } from "../transport/push-bus";
import {
  RENDERER_RESPONSE_CHANNEL,
  RendererRequestBroker,
} from "./renderer-requests";
import { RpcRegistry } from "../transport/rpc-registry";
import { startSidecarServer } from "../transport/sidecar-server";
import { HostWindowOwner } from "../windows/host-window-owner";
import { PendingComposerDraftFlusher } from "../windows/pending-draft-flush";
import {
  readComposerAttachmentsFromPaths,
  validateComposerAttachmentPayload,
} from "./composer-files";
import {
  createOrchestrationRuntimeExtension,
  createScheduledTaskRuntimeExtension,
  createStoreBackedOrchestrationRuntimeBridge,
  createStoreBackedScheduledTaskRuntimeBridge,
  sessionRefFromExtensionContext,
} from "./runtime-bridges";
import { SidecarWindow, type WindowStateReport } from "./window-mirror";
import type { HostWindow } from "../platform/host-window";

const DRAFT_FLUSH_TIMEOUT_MS = 2_000;
const READY_PREFIX = "PI_LUCKY_READY ";
/** A boundary that hangs must not pin a checkout forever. */
const TURN_CAPTURE_BACKSTOP_MS = 15 * 60 * 1000;

function log(message: string, detail?: unknown): void {
  console.log(`[sidecar] ${message}`, detail === undefined ? "" : JSON.stringify(detail));
}

/**
 * pi-lucky keeps its own data directory, portable by default (`<app>/data`).
 *
 * pi-gui (Electron) already owns `%APPDATA%/pi`; sharing it would have two store
 * implementations writing `ui-state.json`, `catalogs.json` and `attachments/` over each
 * other, so the name is deliberately different and the directory is checked below.
 * The resolution rules (and the `PI_LUCKY_USER_DATA_DIR` override) live in `../env.ts`.
 */

/**
 * Refuse a directory that is clearly another app's profile.
 *
 * An explicit `PI_LUCKY_USER_DATA_DIR` pointing at pi-gui's profile would silently
 * overwrite that app's saved state, so it is rejected rather than migrated.
 */
function assertUsableUserDataDir(userDataDir: string): void {
  const foreignMarkers = ["Local State", "Preferences", "lockfile"];
  const ownedMarker = path.join(userDataDir, "pi-lucky.json");
  if (existsSync(ownedMarker)) {
    return;
  }
  const foreign = foreignMarkers.filter((marker) => existsSync(path.join(userDataDir, marker)));
  if (foreign.length === 0) {
    return;
  }
  throw new Error(
    `${userDataDir} looks like another desktop app's profile (found: ${foreign.join(", ")}). ` +
      `Set ${ENV.userDataDir} to a directory owned by pi-lucky instead.`,
  );
}

async function main(): Promise<void> {
  const resolved = resolveUserDataDir();
  const userDataDir = resolved.dir;
  await mkdir(userDataDir, { recursive: true });
  assertUsableUserDataDir(userDataDir);
  await writeFile(
    path.join(userDataDir, "pi-lucky.json"),
    `${JSON.stringify({ app: "pi-lucky" }, null, 2)}\n`,
  );
  if (resolved.source === "appdata") {
    console.warn(
      `[sidecar] ${resolved.portableDir} is not writable; falling back to ${userDataDir}. ` +
        `Set ${ENV.userDataDir} to choose a profile directory explicitly.`,
    );
  }
  log("boot", {
    version: APP_VERSION,
    userDataDir,
    userDataDirSource: resolved.source,
    bun: Bun.version,
  });

  const rpc = new RpcRegistry();
  const bus = new PushBus();
  const rendererRequests = new RendererRequestBroker(bus);
  const window = new SidecarWindow(bus);
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  const themeManager = new ThemeManager();
  const editorService = new EditorService();
  const composerDraftFlusher = new PendingComposerDraftFlusher(DRAFT_FLUSH_TIMEOUT_MS);
  const checkpoints = new TurnCheckpointStore(userDataDir);
  const extensionViews: DesktopExtensionViewOwner = new DesktopExtensionViewOwner({
    // Extension views are loaded from the sidecar's own origin, so the frame document
    // points at the served bridge instead of an inlined srcdoc page.
    frameDocument: ({ bridgeUrl, frontendUrl, nonce }) =>
      [
        "<!doctype html><html><head><meta charset=\"utf-8\" />",
        '<meta http-equiv="Content-Security-Policy" content="default-src ' +
          "'self' " +
          frontendUrl +
          "; script-src 'nonce-" +
          nonce +
          "'" +
          "; style-src 'unsafe-inline' 'self' " +
          frontendUrl +
          '">',
        "</head><body>",
        '<div id="root"></div>',
        '<script nonce="' + nonce + '" src="' + bridgeUrl + '"></script>',
        "</body></html>",
      ].join(""),
    onHostAction: (context) =>
      performExtensionViewHostAction(
        {
          store,
          windows: windows!,
          views: extensionViews,
          openExternal: (url) => shell.openExternal(url),
          saveComposerDraft: (window) => composerDraftFlusher.flush([window]),
        },
        context,
      ),
    onDiagnostic: (target, source, message) =>
      console.error("[extension-view]", target.sessionId, source, message),
  });

  // The window owner observes the store, and the store asks the owner whether a
  // session is visible elsewhere, so one of the two references has to be late-bound.
  let windows: HostWindowOwner | undefined;

  const store: DesktopAppStore = new DesktopAppStore({
    userDataDir,
    initialWorkspacePaths: initialWorkspacePaths(),
    getWindow: () => window,
    purgeTurnCheckpoints: (sessionRef) => checkpoints.removeSession(sessionRef),
    shouldKeepSessionDialogs: (sessionRef) =>
      windows?.isSessionVisibleInAnotherWindow(sessionRef) ?? false,
    driverOptions: {
      onTurnCaptureBoundary: (boundary, signal) => checkpoints.recordBoundary(boundary, signal),
      turnCaptureTimeoutMs: TURN_CAPTURE_BACKSTOP_MS,
      desktopExtensions: {
        onChanged: (runtime) => extensionViews.replaceRuntime(runtime),
        onInvalidated: ({ target, generation }) =>
          extensionViews.invalidateRuntime(target, generation),
      },
      builtinExtensions: [
        {
          name: "pi-gui-thread-orchestration",
          displayName: "Thread orchestration",
          description: "Lets pi start, read and message other pi-lucky threads",
          factory: createOrchestrationRuntimeExtension(
            createStoreBackedOrchestrationRuntimeBridge(() => store),
          ),
        },
        {
          name: "pi-gui-scheduled-tasks",
          displayName: "Scheduled tasks",
          description: "Lets pi create and update local pi-lucky scheduled tasks",
          factory: createScheduledTaskRuntimeExtension(
            createStoreBackedScheduledTaskRuntimeBridge(() => store),
            (ctx) => {
              try {
                return sessionRefFromExtensionContext(store, ctx).workspaceId;
              } catch {
                return undefined;
              }
            },
          ),
        },
      ],
    },
  });

  await store.initialize();
  windows = new HostWindowOwner(store, {
    onActiveWindowChanged: () => undefined,
  });
  windows.add(window);
  themeManager.setMode(store.snapshot().themeMode);
  themeManager.trackWindow(window);

  const notificationPermissionService = new NotificationPermissionService(() => window);
  notificationPermissionService.trackWindow(window);
  configureNotificationSink({
    isSupported: true,
    show: (content) => bus.broadcast("pi-gui:show-notification", content),
  });

  const notificationManager = new NotificationManager(
    store,
    () => window,
    notificationPermissionService,
    async (sessionRef) => {
      await store.selectSession(sessionRef);
      bus.broadcast("pi-gui:window-command", "show");
    },
  );
  const stopNotifications = notificationManager.start();

  let terminalService: TerminalService | undefined;
  const getTerminalService = (): TerminalService => {
    terminalService ??= new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => store.snapshot().integratedTerminalShell,
      isPackaged: isPackaged(),
    });
    return terminalService;
  };

  const reviewOwner = new ReviewOwner({
    checkpoints,
    userDataDir,
    resolveCheckoutPath: (checkoutId) => store.getWorkspacePath(checkoutId),
    validateTask: (target) =>
      store
        .snapshot()
        .workspaces.some(
          (workspace) =>
            workspace.id === target.workspaceId &&
            workspace.sessions.some((session) => session.id === target.sessionId),
        ),
  });

  configureIpcCompat({ rpc, primaryWindow: () => windows.primaryWindow() });

  // Window lifecycle and colour-scheme changes come from the renderer: it is the
  // only side that can observe the native window or the OS preference.
  rpc.handle("pi-gui:window-state", (args) => {
    const report = (args[0] ?? {}) as Partial<WindowStateReport>;
    window.report(report);
    if (report.focused) {
      windows.setFocusedWindow(window);
    }
    return undefined;
  });
  rpc.handle(RENDERER_RESPONSE_CHANNEL, (args) => {
    rendererRequests.settle(args[0]);
    return undefined;
  });
  rpc.handle("pi-gui:system-theme", (args) => {
    nativeTheme.reportSystemPreference(args[0] === true);
    return undefined;
  });

  registerDesktopIpc({
    rpc,
    windows,
    owners: {
      state: store,
      workbench: store,
      extensionViews,
      review: reviewOwner,
      workspace: store,
      conversation: store,
      orchestration: store,
      scheduledTasks: store,
      settings: store,
      composerDraftFlush: composerDraftFlusher,
    },
    capabilities: {
      ping: () => "pi-lucky sidecar ready",
      theme: themeManager,
      editors: editorService,
      openExternal: (url: string) => shell.openExternal(url),
      // The folder picker is a webview dialog; adding the workspace is sidecar work.
      pickWorkspace: async (window: HostWindow) => {
        const picked = await rendererRequests.request<string>({
          kind: "open-folder",
          titleKey: "shell.openWorkspaceFolder",
        });
        if (!picked) {
          return windows!.stateForWindow(window);
        }
        return windows!.runStateAction(window, () => store.addWorkspace(picked));
      },
      // Provider login needs a browser and a text prompt: the renderer opens the URL
      // and asks for the code, and the sidecar waits for its answer.
      createLoginCallbacks: () => ({
        onAuth: async ({ url, instructions }: { url: string; instructions?: string }) => {
          await shell.openExternal(url);
          const trimmed = instructions?.trim();
          if (trimmed) {
            await rendererRequests.request({ kind: "alert", message: trimmed });
          }
        },
        onPrompt: async ({
          message,
          placeholder,
          allowEmpty,
        }: {
          message: string;
          placeholder?: string;
          allowEmpty?: boolean;
        }) => {
          const value = await rendererRequests.request({
            kind: "prompt",
            message,
            placeholder,
            allowEmpty: allowEmpty ?? false,
          });
          const trimmed = value.trim();
          if (!allowEmpty && trimmed.length === 0) {
            throw new Error("Login cancelled.");
          }
          return trimmed;
        },
      }),
      probeCustomProviderModels,
      testCustomProviderModel,
      notificationPermission: () => notificationPermissionService,
      terminal: getTerminalService,
      optionalTerminal: () => terminalService,
      setTerminalFocused: () => undefined,
      setSidePanelFocused: () => undefined,
      setTransparency: () => undefined,
      pickComposerAttachments: async (_window, existing = []) => {
        const selection = await rendererRequests.request<string[]>({
          kind: "open-files",
          titleKey: "shell.attachFiles",
          multiSelections: true,
        });
        if (!selection || selection.length === 0) {
          return undefined;
        }
        return readComposerAttachmentsFromPaths(selection, existing);
      },
      readClipboardImage: () => ({ ok: false }),
      validateComposerAttachments: (attachments) =>
        attachments.flatMap(validateComposerAttachmentPayload),
      listWorkspaceFiles: (workspacePath, options) => listWorkspaceFiles(workspacePath, options),
      readWorkspaceFile: (workspacePath, filePath) => readWorkspaceFile(workspacePath, filePath),
      revealWorkspaceFile: async (workspacePath, filePath) => {
        const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
        await shell.showItemInFolder(resolved);
      },
      getChangedFiles: (workspacePath) => getChangedFiles(workspacePath),
      getFileDiff: (workspacePath, filePath) => getFileDiff(workspacePath, filePath),
      stageFile: (workspacePath, filePath, options) => stageFile(workspacePath, filePath, options),
      relaunchApplication: () => void shutdown("relaunch"),
    },
  });

  const server = startSidecarServer({ rpc, bus, token, version: APP_VERSION });
  await writeFile(
    path.join(userDataDir, "runtime.json"),
    JSON.stringify({ pid: process.pid, port: server.port, version: APP_VERSION }, null, 2),
    "utf8",
  );

  const stopPruningTerminals = store.subscribe((state) => {
    terminalService?.retainWorkspacePaths(state.workspaces.map((workspace) => workspace.path));
  });

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log("shutdown", reason);
    stopPruningTerminals();
    stopNotifications();
    notificationPermissionService.dispose();
    terminalService?.dispose();
    server.stop();
    process.exit(0);
  }

  log("attached", { channels: rpc.size, port: server.port });
  console.log(
    `${READY_PREFIX}${JSON.stringify({ port: server.port, token, version: APP_VERSION })}`,
  );

  // The shell owns this process: when its stdin closes, the window is gone.
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.stdin.resume();
  process.on("SIGTERM", () => shutdown("sigterm"));
  process.on("SIGINT", () => shutdown("sigint"));
}

void main().catch((error: unknown) => {
  // The shell reads stderr and surfaces it, so print the lesson, not a stack trace.
  console.error(`[sidecar] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
