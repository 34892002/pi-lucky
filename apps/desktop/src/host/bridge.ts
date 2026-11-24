/**
 * `window.piApp` — the port of pi-gui's Electron preload.
 *
 * Two kinds of channels:
 *  - **server**: business logic that moved into the sidecar (same channel strings,
 *    now HTTP/WS instead of IPC);
 *  - **local**: things only the native shell can do (window controls, clipboard,
 *    notifications, app commands), which the bridge answers with Neutralino APIs
 *    directly instead of a sidecar round-trip.
 *
 * Everything not overridden locally is routed from the generated preload map, so a
 * method pi-gui adds later works here without hand-maintaining a second list.
 */
import { neutralino, type ClipboardImage } from "./neutralino";
import { shellTranslator } from "./shell-locale";
import { applicationName } from "../../../../neutralino.config.json";
import { NEW_THREAD_PLACEHOLDER_TITLE } from "../../host/conversation/thread-title-constants";
import { desktopIpc } from "../../contracts/ipc";
import type { PiDesktopApi, PiDesktopCommand } from "../../contracts/ipc";
import type { ComposerAttachment, DesktopAppState } from "../../contracts/desktop-state";
import type { ClipboardImageRead } from "../../contracts/composer-attachments";
import { BRIDGE_METHODS, type BridgeCallKind } from "./generated/bridge-map";
import type { HostTransport } from "./transport";

export interface BridgeConfig {
  readonly transport: HostTransport;
  readonly platform: string;
  readonly drawsWindowControls: boolean;
  readonly versions: Record<string, string>;
  readonly isMaximized: () => boolean;
  readonly setMaximized: (maximized: boolean) => void;
}

export interface PiAppBridge {
  /** Assigned to `window.piApp`, exactly as the preload did. */
  readonly api: PiDesktopApi;
  /** App-menu commands, for the accelerators the native menu used to provide. */
  dispatchCommand(command: PiDesktopCommand): void;
  /** Pushes that used to originate in the main process, now raised by the shell. */
  emitLocalPush(channel: string, payload: unknown): void;
}

/**
 * Channels the shell raises itself instead of the sidecar.
 *
 * pi-gui emitted these from the main process (menu picks, global paste, permission
 * changes); in a single renderer they have no server-side producer left.
 */
const LOCAL_PUSH_CHANNELS = new Set<string>([
  desktopIpc.clipboardImagePasted,
  desktopIpc.workspacePicked,
  desktopIpc.notificationPermissionStatusChanged,
]);

type AnyMethod = (...args: never[]) => unknown;

function channelFor(channelKey: string): string {
  const value = (desktopIpc as Record<string, string>)[channelKey];
  if (!value) {
    throw new Error(`Unknown desktopIpc key: ${channelKey}`);
  }
  return value;
}

/** Neutralino hands back raw BGRA pixels; the composer needs an encoded PNG. */
async function clipboardImageToDataUrl(image: ClipboardImage): Promise<string | undefined> {
  const { width, height, bpp, data } = image;
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  const bytes = new Uint8Array(data);
  const pixelBytes = bpp / 8;
  if (!Number.isInteger(pixelBytes) || pixelBytes < 3) {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }
  const imageData = context.createImageData(width, height);
  const target = imageData.data;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * pixelBytes;
    const destination = pixel * 4;
    const blue = bytes[source] ?? 0;
    const green = bytes[source + 1] ?? 0;
    const red = bytes[source + 2] ?? 0;
    const alpha = pixelBytes >= 4 ? (bytes[source + 3] ?? 255) : 255;
    target[destination] = red;
    target[destination + 1] = green;
    target[destination + 2] = blue;
    target[destination + 3] = alpha;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

export function createPiAppBridge(config: BridgeConfig): PiAppBridge {
  const { transport } = config;
  const commandListeners = new Set<(command: PiDesktopCommand) => void>();
  const draftFlushHandlers = new Set<() => Promise<void>>();
  const localSubscribers = new Map<string, Set<(payload: unknown) => void>>();

  function subscribeLocal(channel: string, listener: (payload: unknown) => void): () => void {
    const listeners = localSubscribers.get(channel) ?? new Set();
    localSubscribers.set(channel, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function emitLocalPush(channel: string, payload: unknown): void {
    for (const listener of localSubscribers.get(channel) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[bridge] local push listener failed for ${channel}`, error);
      }
    }
  }

  const invokeServer = (channel: string, args: readonly unknown[]) =>
    transport.invoke(channel, args);

  function dispatchCommand(command: PiDesktopCommand): void {
    for (const listener of commandListeners) {
      try {
        listener(command);
      } catch (error) {
        console.error("[bridge] command listener failed", error);
      }
    }
  }

  async function flushPendingDrafts(): Promise<void> {
    await Promise.allSettled([...draftFlushHandlers].map((handler) => handler()));
  }

  async function readClipboardImage(): Promise<ClipboardImageRead> {
    try {
      const image = await neutralino().clipboard.readImage();
      if (!image) {
        return { ok: false };
      }
      const dataUrl = await clipboardImageToDataUrl(image);
      if (!dataUrl) {
        return { ok: false, code: "decode-failed" };
      }
      return {
        ok: true,
        attachment: {
          id: crypto.randomUUID(),
          kind: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const local: Record<string, AnyMethod> = {
    minimizeWindow: () => {
      void neutralino().window.minimize();
    },
    toggleWindowMaximize: () => {
      if (config.isMaximized()) {
        void neutralino().window.unmaximize();
        config.setMaximized(false);
        return;
      }
      void neutralino().window.maximize();
      config.setMaximized(true);
    },
    closeWindow: async () => {
      await flushPendingDrafts();
      await neutralino().app.exit();
    },
    openExternal: (url: string) => neutralino().os.open(url),
    relaunchApplication: () => neutralino().app.restartProcess(),
    readClipboardImage,
    // Neutralino never exposes a dropped file's path, and inventing one would be
    // worse than the documented gap: non-image drops fall back to a byte upload.
    getPathForFile: (_file: File) => "",
    getNotificationPermissionStatus: async () => "granted",
    requestNotificationPermission: async () => "granted",
    openSystemNotificationSettings: async () => {
      await neutralino().os.open("ms-settings:notifications");
    },
    onCommand: (listener: (command: PiDesktopCommand) => void) => {
      commandListeners.add(listener);
      return () => {
        commandListeners.delete(listener);
      };
    },
    onPendingComposerDraftFlush: (handler: () => Promise<void>) => {
      draftFlushHandlers.add(handler);
      return () => {
        draftFlushHandlers.delete(handler);
      };
    },
    getThemeMode: () => globalThis.localStorage.getItem("pi-theme-mode") ?? "system",
    // `deleteSession` is not in pi-gui's preload, so the generated bridge map cannot
    // provide it; forward it like the other server-backed methods above.
    deleteSession: (target: unknown) => invokeServer(channelFor("deleteSession"), [target]),
    addComposerAttachments: (attachments: readonly ComposerAttachment[]) =>
      invokeServer(channelFor("addComposerAttachments"), [attachments]),
    pickComposerAttachments: () => invokeServer(channelFor("pickComposerAttachments"), []),
    pickWorkspace: (): Promise<DesktopAppState> =>
      invokeServer(channelFor("pickWorkspace"), []) as Promise<DesktopAppState>,
  };

  function makeInvoker(channel: string, kind: BridgeCallKind): AnyMethod {
    if (kind === "subscribe") {
      return ((listener: (payload: unknown) => void) =>
        LOCAL_PUSH_CHANNELS.has(channel)
          ? subscribeLocal(channel, listener)
          : transport.subscribe(channel, listener)) as AnyMethod;
    }
    if (kind === "send") {
      return ((...args: unknown[]) => {
        void invokeServer(channel, args);
      }) as AnyMethod;
    }
    return ((...args: unknown[]) => invokeServer(channel, args)) as AnyMethod;
  }

  const base: Record<string, unknown> = {
    platform: config.platform,
    drawsWindowControls: config.drawsWindowControls,
    versions: config.versions,
  };

  for (const [method, [channelKey, kind]] of Object.entries(BRIDGE_METHODS)) {
    if (method in local) {
      continue;
    }
    base[method] = makeInvoker(channelFor(channelKey), kind);
  }
  Object.assign(base, local);

  // Server-side notifications are raised as native toasts by the shell.
  transport.subscribe("pi-gui:show-notification", (payload) => {
    const { title, body, kind } = (payload ?? {}) as {
      title?: string;
      body?: string;
      kind?: string;
    };
    if (!title) return;
    const t = shellTranslator();
    const subject = title === NEW_THREAD_PLACEHOLDER_TITLE ? t("topbar.newThread") : title;
    const message = kind === "runCompleted" ? t("shell.notification.runCompleted") : body;
    const content = [subject === applicationName ? undefined : subject, message]
      .filter(Boolean)
      .join(" · ");
    void neutralino().os.showNotification(applicationName, content)
      .catch((error: unknown) => console.error("[shell] showNotification failed", error));
  });

  return { api: base as unknown as PiDesktopApi, dispatchCommand, emitLocalPush };
}

