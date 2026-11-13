/**
 * Notification permission, Windows-only.
 *
 * pi-gui's version was 381 lines of cross-platform choreography: WebKit's
 * `Notification.requestPermission()` inside the renderer, a signed macOS helper
 * binary queried over `execFile`, a polling reconciliation loop after the user came
 * back from System Settings, and teardown of `app.on("activate")` listeners.
 *
 * None of that exists on Windows. Toasts are gated by the per-app switch in
 * Settings → System → Notifications, there is no runtime prompt to answer and no
 * webview API to ask, so the only honest status is "granted": Windows either shows
 * the toast or silently drops it, and the app cannot tell which. What remains here
 * is the shape the rest of the host code expects — `trackWindow`, `subscribe`,
 * `ensurePermission`, `openSystemSettings` — so callers port unchanged.
 */
import type { DesktopNotificationPermissionStatus } from "../../contracts/ipc";
import type { BrowserWindow } from "./native-shell";

const WINDOWS_NOTIFICATION_SETTINGS = "ms-settings:notifications";

export interface NotificationSettingsOpener {
  (uri: string): Promise<void>;
}

export class NotificationPermissionService {
  private window: BrowserWindow | null = null;
  private readonly listeners = new Set<(status: DesktopNotificationPermissionStatus) => void>();
  private openedByUser = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly openSettings: NotificationSettingsOpener = async (uri) => {
      const { shell } = await import("../transport/ipc-compat");
      await shell.openExternal(uri);
    },
  ) {}

  dispose(): void {
    this.trackWindow(null);
    this.listeners.clear();
  }

  trackWindow(window: BrowserWindow | null): void {
    this.window = window && !window.isDestroyed() ? window : null;
  }

  subscribe(listener: (status: DesktopNotificationPermissionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getCurrentStatus(): Promise<DesktopNotificationPermissionStatus> {
    // Windows exposes no readable per-app notification permission to a desktop app.
    return "granted";
  }

  async requestPermission(): Promise<DesktopNotificationPermissionStatus> {
    return "granted";
  }

  async ensurePermission(): Promise<DesktopNotificationPermissionStatus> {
    return "granted";
  }

  /** The only actionable path on Windows is sending the user to the settings page. */
  async openSystemSettings(): Promise<void> {
    this.openedByUser = true;
    await this.openSettings(WINDOWS_NOTIFICATION_SETTINGS);
  }

  /** True once the user was sent to Settings; the UI uses this to stop nagging. */
  get hasSentUserToSettings(): boolean {
    return this.openedByUser;
  }

  private publish(status: DesktopNotificationPermissionStatus): void {
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
