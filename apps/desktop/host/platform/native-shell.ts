/**
 * Host-native observability shims for the ported platform services.
 *
 * pi-gui's theme, notification and updater services are mostly policy: when to
 * notify, when to re-evaluate onboarding, how to throttle repeats. They only touch
 * Electron for the *last centimetre* — `nativeTheme`, `Notification`, and
 * `BrowserWindow` bookkeeping. This module supplies those three names so the policy
 * code ports unchanged, wired to the renderer instead of the OS:
 *
 *   nativeTheme.shouldUseDarkColors → reported by the webview (prefers-color-scheme)
 *   new Notification(...).show()    → push to the webview, shown with Neutralino
 *   window.isDestroyed()/webContents → the sidecar's window mirror
 */
import type { HostContents, HostWindow } from "./host-window";

export type BrowserWindow = HostWindow;
export type WebContents = HostContents;

export interface NotificationSink {
  readonly show: (input: { readonly title: string; readonly body: string }) => void;
  readonly isSupported: boolean;
}

const notificationSink = {
  isSupported: true,
  // Replaced at boot via configureNotificationSink; the default keeps the ported
  // services running in tests and probe harnesses without a renderer.
  show: (_input: { readonly title: string; readonly body: string }): void => {},
};

export function configureNotificationSink(sink: NotificationSink): void {
  notificationSink.isSupported = sink.isSupported;
  notificationSink.show = sink.show;
}

type NotificationListener = () => void;

/** The slice of Electron's `Notification` the ported services use. */
export class Notification {
  private readonly listeners = new Map<string, NotificationListener[]>();

  constructor(
    private readonly options: {
      readonly title: string;
      readonly body: string;
      readonly silent?: boolean;
    },
  ) {}

  static isSupported(): boolean {
    return notificationSink.isSupported;
  }

  on(event: string, listener: NotificationListener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  show(): void {
    notificationSink.show({ title: this.options.title, body: this.options.body });
  }

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) {
      listener();
    }
    this.listeners.clear();
  }
}

type ThemeListener = () => void;

/**
 * `nativeTheme` without Chromium: the renderer owns the OS preference and reports
 * changes, so `shouldUseDarkColors` is whatever it last said.
 */
class NativeTheme {
  private listeners: ThemeListener[] = [];
  private systemPrefersDark = false;

  get shouldUseDarkColors(): boolean {
    return this.systemPrefersDark;
  }

  /** `themeSource` has no OS-level meaning here; the store keeps the mode. */
  set themeSource(_source: string) {
    // no-op: neutrality is preserved by ThemeManager's own mode field
  }

  on(_event: "updated", listener: ThemeListener): void {
    this.listeners.push(listener);
  }

  reportSystemPreference(prefersDark: boolean): void {
    if (this.systemPrefersDark === prefersDark) {
      return;
    }
    this.systemPrefersDark = prefersDark;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const nativeTheme = new NativeTheme();
