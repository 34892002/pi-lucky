/**
 * The sidecar's mirror of the one Neutralino window.
 *
 * pi-gui's `WindowOwner` bookkeeping (which window is focused, which session each
 * window shows, whether a window is even alive) is transport-agnostic but was typed
 * against Electron. This class supplies the same surface: `send` becomes a WebSocket
 * push, and the events Electron fired from the OS (`focus`, `show`, `restore`) arrive
 * from the renderer, which is the only side that can observe the native window.
 */
import type { HostContents, HostWindow, HostWindowEvent } from "../platform/host-window";
import type { PushBus } from "../transport/push-bus";

const WINDOW_ID = 1;

export interface WindowStateReport {
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly visible: boolean;
  readonly maximized: boolean;
}

export class SidecarWindow implements HostWindow {
  readonly webContents: HostContents;
  private readonly listeners = new Map<string, Set<() => void>>();
  private state: WindowStateReport = {
    focused: false,
    minimized: false,
    visible: true,
    maximized: false,
  };
  private destroyed = false;

  constructor(private readonly bus: PushBus) {
    this.webContents = {
      id: WINDOW_ID,
      isDestroyed: () => this.destroyed,
      isCrashed: () => false,
      send: (channel, payload) => {
        this.bus.broadcast(channel, payload);
      },
      on: () => () => undefined,
      once: () => () => undefined,
      off: () => undefined,
    };
  }

  /** Apply what the renderer reports about its own native window. */
  report(next: Partial<WindowStateReport>): void {
    const previous = this.state;
    this.state = { ...previous, ...next };
    if (!previous.focused && this.state.focused) {
      this.emit("focus");
    } else if (previous.focused && !this.state.focused) {
      this.emit("blur");
    }
    if (previous.minimized && !this.state.minimized) {
      this.emit("restore");
    } else if (!previous.minimized && this.state.minimized) {
      this.emit("minimize");
    }
    if (!previous.visible && this.state.visible) {
      this.emit("show");
    } else if (previous.visible && !this.state.visible) {
      this.emit("hide");
    }
  }

  markDestroyed(): void {
    this.destroyed = true;
    this.emit("close");
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.state.minimized;
  }

  isVisible(): boolean {
    return this.state.visible && !this.destroyed;
  }

  isFocused(): boolean {
    return this.state.focused;
  }

  isMaximized(): boolean {
    return this.state.maximized;
  }

  // Window operations run in the renderer, which owns the native window; the
  // sidecar asks it to perform them.
  maximize(): void {
    this.bus.broadcast("pi-gui:window-command", "maximize");
  }

  unmaximize(): void {
    this.bus.broadcast("pi-gui:window-command", "unmaximize");
  }

  minimize(): void {
    this.bus.broadcast("pi-gui:window-command", "minimize");
  }

  close(): void {
    this.bus.broadcast("pi-gui:window-command", "close");
  }

  restore(): void {
    this.bus.broadcast("pi-gui:window-command", "restore");
  }

  show(): void {
    this.bus.broadcast("pi-gui:window-command", "show");
  }

  focus(): void {
    this.bus.broadcast("pi-gui:window-command", "focus");
  }

  on(event: HostWindowEvent | string, listener: () => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  once(event: HostWindowEvent | string, listener: () => void): () => void {
    const unsubscribe = this.on(event, () => {
      unsubscribe();
      listener();
    });
    return unsubscribe;
  }

  off(event: HostWindowEvent | string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener();
      } catch (error) {
        console.error(`[window] ${event} listener failed`, error);
      }
    }
  }
}
