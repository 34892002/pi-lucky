/**
 * The native-window surface the ported pi-gui host code expects.
 *
 * pi-gui talked to Electron's `BrowserWindow`/`WebContents`. Neutralino has no
 * server-side window object — the webview owns the real window — so the sidecar
 * keeps a mirror that the renderer updates over RPC (`pi-gui:window-state`) and
 * pushes to over the WebSocket.
 *
 * `webContents` is preserved as a member (rather than flattened) so the ~600 lines
 * of window bookkeeping ported from `windows/window-owner.ts` stay a straight copy:
 * in Neutralino a "contents" is just the renderer tab, and its `send` is a push.
 */
export interface HostContents {
  /** Stable identity of this renderer tab; the sidecar treats it as the window id. */
  readonly id: number;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: string, payload?: unknown): void;
  /** Returns an unsubscribe handle; Neutralino never "reloads" contents on its own. */
  on(event: HostContentEvent | string, listener: (...args: never[]) => void): () => void;
  once(event: HostContentEvent | string, listener: (...args: never[]) => void): () => void;
  off(event: HostContentEvent | string, listener: (...args: never[]) => void): void;
}

export type HostContentEvent = "render-process-gone" | "did-finish-load";

export type HostWindowEvent = "focus" | "blur" | "show" | "hide" | "restore" | "minimize" | "close";

/**
 * The narrow slice the app store observes. `app-store` only ever calls these four
 * predicates, which is why the store could drop its Electron import outright.
 */
export interface HostWindow {
  readonly webContents: HostContents;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMaximized(): boolean;
  // Window operations are forwarded to the webview, which owns the native window.
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
  close(): void;
  on(event: HostWindowEvent | string, listener: () => void): () => void;
  once(event: HostWindowEvent | string, listener: () => void): () => void;
  off(event: HostWindowEvent | string, listener: () => void): void;
  restore(): void;
  show(): void;
  focus(): void;
}

export const NO_WINDOW: () => HostWindow | null = () => null;
