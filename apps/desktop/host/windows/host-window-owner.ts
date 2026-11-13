import type { HostContents, HostWindow } from "../platform/host-window";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  AppView,
  DesktopAppState,
  DesktopAppViewState,
  SelectedTranscriptRecord,
  SessionExtensionUiUpdate,
} from "../../contracts/desktop-state";
import { selectedTranscriptPatch } from "../../contracts/desktop-state";
import { desktopIpc } from "../../contracts/ipc";
import { SerializedActionQueue } from "./action-queue";

interface WindowViewState {
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarCollapsed: boolean;
}

export interface WindowStateOwner {
  snapshot(): DesktopAppState;
  applyView(view: DesktopAppViewState): DesktopAppState;
  projectStateForView(
    view: DesktopAppViewState,
    state: DesktopAppState,
    previousView?: DesktopAppViewState,
  ): DesktopAppState;
  getState(): Promise<DesktopAppState>;
  getStateForView(view: DesktopAppViewState): Promise<DesktopAppState>;
  getSelectedTranscriptForView(view: DesktopAppViewState): Promise<SelectedTranscriptRecord | null>;
  subscribe(listener: (state: DesktopAppState) => void): () => void;
  subscribeToSelectedTranscript(listener: () => void): () => void;
  subscribeToExtensionUi(listener: (update: SessionExtensionUiUpdate) => void): () => void;
  emit(): void;
  handleWindowActivation(): void;
}

export interface HostWindowOwnerOptions {
  readonly onActiveWindowChanged?: (window: HostWindow | null) => void;
  readonly onWindowClosed?: (window: HostWindow) => void;
}

export interface WindowActionOptions {
  readonly forceActiveWindow?: boolean;
}

function viewFromState(state: DesktopAppState): WindowViewState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}

const NO_ORCHESTRATION_CHILDREN: DesktopAppState["orchestrationChildren"] = [];

// Full child records carry every child thread's transcript and the window never
// reads them, so pushes drop them. The window draws the tree from childThreadLinks,
// which every push and every getState() reply carries.
function stateForPush(state: DesktopAppState): DesktopAppState {
  return state.orchestrationChildren.length === 0
    ? state
    : { ...state, orchestrationChildren: NO_ORCHESTRATION_CHILDREN };
}

function canPublishToWindow(window: HostWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

export class HostWindowOwner {
  private readonly lastPublishedTranscript = new Map<number, SelectedTranscriptRecord | null>();
  // The model catalog each window last received. It is large and rarely changes, so pushes
  // leave it out while it is the same object.
  private readonly lastPublishedCatalog = new Map<number, DesktopAppState["runtimeByWorkspace"]>();
  private readonly windows = new Set<HostWindow>();
  private readonly windowByContents = new Map<number, HostWindow>();
  private readonly windowIds = new WeakMap<HostWindow, number>();
  private readonly views = new Map<number, WindowViewState>();
  private readonly stopPublishingState = new Map<number, () => void>();
  private readonly stopPublishingTranscript = new Map<number, () => void>();
  private readonly stopPublishingExtensionUi = new Map<number, () => void>();
  private readonly stopTrackingActivation = new Map<number, () => void>();
  private readonly actionQueue = new SerializedActionQueue();
  private activeWindow: HostWindow | null = null;
  private focused: HostWindow | null = null;
  private activeActionWindowId: number | undefined;
  private deferredActivationWindowId: number | undefined;
  private composerDraftPersistOriginWindowId: number | undefined;

  constructor(
    private readonly stateOwner: WindowStateOwner,
    private readonly options: HostWindowOwnerOptions = {},
  ) {}

  add(window: HostWindow, sourceView?: DesktopAppViewState): void {
    const webContentsId = window.webContents.id;
    this.windows.add(window);
    this.windowIds.set(window, webContentsId);
    this.windowByContents.set(webContentsId, window);
    // A window counts as focused until the renderer reports otherwise: the sidecar
    // cannot observe native focus on its own.
    this.focused ??= window;
    this.views.set(webContentsId, this.resolveView(sourceView));
    this.setActiveWindow(window);
    this.attachStatePublisher(window);
    this.attachActivationTracking(window);
  }

  remove(window: HostWindow): void {
    const webContentsId = this.windowIds.get(window);
    if (webContentsId === undefined) {
      return;
    }
    this.stopPublishingState.get(webContentsId)?.();
    this.stopPublishingState.delete(webContentsId);
    this.stopPublishingTranscript.get(webContentsId)?.();
    this.stopPublishingTranscript.delete(webContentsId);
    this.stopPublishingExtensionUi.get(webContentsId)?.();
    this.stopPublishingExtensionUi.delete(webContentsId);
    this.stopTrackingActivation.get(webContentsId)?.();
    this.stopTrackingActivation.delete(webContentsId);
    this.windows.delete(window);
    this.windowIds.delete(window);
    this.windowByContents.delete(webContentsId);
    if (this.focused === window) {
      this.focused = null;
    }
    this.views.delete(webContentsId);
    this.lastPublishedTranscript.delete(webContentsId);
    this.lastPublishedCatalog.delete(webContentsId);

    if (this.activeWindow === window) {
      this.activeWindow = [...this.windows].find((candidate) => !candidate.isDestroyed()) ?? null;
      if (this.activeWindow) {
        this.setActiveWindow(this.activeWindow);
        this.applyViewToStateOwner(this.activeWindow.webContents.id);
      } else {
        this.options.onActiveWindowChanged?.(null);
      }
    }
    this.options.onWindowClosed?.(window);
  }

  allWindows(): readonly HostWindow[] {
    return [...this.windows];
  }

  size(): number {
    return this.windows.size;
  }

  active(): HostWindow | null {
    return this.activeWindow && canPublishToWindow(this.activeWindow) ? this.activeWindow : null;
  }

  /** Neutralino reports focus from the webview; the sidecar mirrors it here. */
  setFocusedWindow(window: HostWindow | null): void {
    this.focused = window;
  }

  private focusedWindow(): HostWindow | null {
    return this.focused && canPublishToWindow(this.focused) ? this.focused : null;
  }

  /** The single window the sidecar serves; throws when no renderer has attached. */
  /** Resolve a renderer-reported contents id (extension view actions carry one). */
  contentsById(id: number): HostContents | undefined {
    const window = this.windowByContents.get(id);
    return window && canPublishToWindow(window) ? window.webContents : undefined;
  }

  primaryWindow(): HostWindow {
    const window = [...this.windows][0];
    if (!window || !canPublishToWindow(window)) {
      throw new Error("RPC sender is not an active pi-lucky window");
    }
    return window;
  }

  foreground(): HostWindow | null {
    const focusedWindow = this.focusedWindow();
    if (
      focusedWindow &&
      this.views.has(focusedWindow.webContents.id) &&
      canPublishToWindow(focusedWindow)
    ) {
      return focusedWindow;
    }
    if (this.activeWindow && canPublishToWindow(this.activeWindow)) {
      return this.activeWindow;
    }
    return [...this.windows].find(canPublishToWindow) ?? null;
  }

  foregroundView(): DesktopAppViewState | undefined {
    const window = this.foreground();
    return window ? this.viewForWindow(window) : undefined;
  }

  resolveDialogWindow(parentWindow?: HostWindow | null): HostWindow | undefined {
    if (parentWindow && canPublishToWindow(parentWindow)) {
      return parentWindow;
    }
    return this.active() ?? undefined;
  }

  windowForSender(sender: HostContents): HostWindow {
    const window = this.windowByContents.get(sender.id);
    if (!window || !this.windows.has(window) || !canPublishToWindow(window)) {
      throw new Error("IPC sender is not an active pi-gui window");
    }
    return window;
  }

  viewForSender(sender: HostContents): DesktopAppViewState {
    const window = this.windowForSender(sender);
    return this.viewForWindow(window);
  }

  viewForWindow(window: HostWindow): DesktopAppViewState {
    return this.views.get(window.webContents.id) ?? viewFromState(this.stateOwner.snapshot());
  }

  targetForSender(sender: HostContents): SessionRef | undefined {
    const view = this.viewForSender(sender);
    return view.selectedWorkspaceId && view.selectedSessionId
      ? { workspaceId: view.selectedWorkspaceId, sessionId: view.selectedSessionId }
      : undefined;
  }

  async stateForWindow(window?: HostWindow | null): Promise<DesktopAppState> {
    if (window && canPublishToWindow(window)) {
      return this.stateOwner.getStateForView(this.viewForWindow(window));
    }
    return this.stateOwner.getState();
  }

  isSessionVisibleInAnotherWindow(sessionRef: SessionRef): boolean {
    for (const window of this.windows) {
      if (!canPublishToWindow(window) || window.isMinimized() || !window.isVisible()) {
        continue;
      }
      const webContentsId = window.webContents.id;
      if (webContentsId === this.activeActionWindowId) {
        continue;
      }
      const view = this.views.get(webContentsId);
      if (
        view?.activeView === "threads" &&
        view.selectedWorkspaceId === sessionRef.workspaceId &&
        view.selectedSessionId === sessionRef.sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  activate(window: HostWindow): void {
    if (!this.windows.has(window) || window.isDestroyed()) {
      return;
    }
    if (this.activeActionWindowId !== undefined) {
      this.deferredActivationWindowId = window.webContents.id;
      return;
    }
    this.applyActivation(window);
  }

  async runStateAction(
    window: HostWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
    options: WindowActionOptions = {},
  ): Promise<DesktopAppState> {
    return this.enqueueAction(async () => {
      const context = this.beginAction(window, options);
      try {
        const state = await action();
        if (!context.window || context.webContentsId === undefined) {
          return state;
        }
        return this.finishStateAction(context.window, state);
      } finally {
        this.endAction(context.webContentsId, context.previousActionWindowId);
      }
    });
  }

  async runStateResultAction<T extends { readonly state: DesktopAppState }>(
    window: HostWindow | null | undefined,
    action: () => Promise<T>,
    options: WindowActionOptions = {},
  ): Promise<T> {
    return this.enqueueAction(async () => {
      const context = this.beginAction(window, options);
      try {
        const result = await action();
        if (!context.window || context.webContentsId === undefined) {
          return result;
        }
        const state = this.finishStateAction(context.window, result.state);
        return { ...result, state };
      } finally {
        this.endAction(context.webContentsId, context.previousActionWindowId);
      }
    });
  }

  async runUnscopedStateAction(
    window: HostWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> {
    const state = await action();
    if (!window || !canPublishToWindow(window)) {
      return state;
    }
    return this.projectAndRemember(window.webContents.id, state);
  }

  async runImmediateStateAction(
    window: HostWindow | null | undefined,
    action: () => Promise<DesktopAppState>,
  ): Promise<DesktopAppState> {
    const state = await action();
    if (!window || !canPublishToWindow(window)) {
      return state;
    }
    const projected = this.projectAndRemember(window.webContents.id, state);
    this.lastPublishedCatalog.set(window.webContents.id, projected.runtimeByWorkspace);
    window.webContents.send(desktopIpc.stateChanged, stateForPush(projected));
    this.publishTranscriptSoon(window);
    return projected;
  }

  async withComposerDraftPersistOrigin<T>(
    sender: HostContents,
    action: () => Promise<T>,
  ): Promise<T> {
    const previousOrigin = this.composerDraftPersistOriginWindowId;
    this.composerDraftPersistOriginWindowId = this.windowForSender(sender).webContents.id;
    try {
      return await action();
    } finally {
      this.composerDraftPersistOriginWindowId = previousOrigin;
    }
  }

  private resolveView(sourceView?: DesktopAppViewState): WindowViewState {
    const state = this.stateOwner.snapshot();
    return viewFromState(
      this.stateOwner.projectStateForView({ ...viewFromState(state), ...sourceView }, state),
    );
  }

  private projectState(
    webContentsId: number,
    state: DesktopAppState = this.stateOwner.snapshot(),
    view: WindowViewState = this.views.get(webContentsId) ?? viewFromState(state),
    previousView: WindowViewState | undefined = this.views.get(webContentsId),
  ): DesktopAppState {
    const projected = this.stateOwner.projectStateForView(view, state, previousView);
    if (
      projected.composerDraftSyncSource === "persist" &&
      this.composerDraftPersistOriginWindowId !== undefined &&
      webContentsId !== this.composerDraftPersistOriginWindowId
    ) {
      return { ...projected, composerDraftSyncSource: "remote-persist" };
    }
    return projected;
  }

  private projectAndRemember(webContentsId: number, state: DesktopAppState): DesktopAppState {
    const projected = this.projectState(webContentsId, state);
    this.views.set(webContentsId, viewFromState(projected));
    return projected;
  }

  private publishState(
    window: HostWindow,
    state: DesktopAppState = this.stateOwner.snapshot(),
  ): void {
    if (!canPublishToWindow(window)) {
      return;
    }
    const webContentsId = window.webContents.id;
    const view =
      webContentsId === this.activeActionWindowId
        ? viewFromState(state)
        : (this.views.get(webContentsId) ?? viewFromState(state));
    const projected = this.projectState(webContentsId, state, view);
    this.views.set(webContentsId, viewFromState(projected));
    const pushed = stateForPush(projected);
    if (this.lastPublishedCatalog.get(webContentsId) === projected.runtimeByWorkspace) {
      const { runtimeByWorkspace: _unchanged, ...withoutCatalog } = pushed;
      window.webContents.send(desktopIpc.stateChanged, withoutCatalog);
      return;
    }
    this.lastPublishedCatalog.set(webContentsId, projected.runtimeByWorkspace);
    window.webContents.send(desktopIpc.stateChanged, pushed);
  }

  private async publishTranscript(window: HostWindow): Promise<void> {
    if (!canPublishToWindow(window)) {
      return;
    }
    const webContentsId = window.webContents.id;
    const payload = await this.stateOwner.getSelectedTranscriptForView(this.viewForWindow(window));
    if (!canPublishToWindow(window)) {
      return;
    }
    // Transcript arrays are replaced on writes, so identity detects changes
    // without serializing unchanged transcripts for unrelated session events.
    // Check it before projecting state, which clones the whole app state.
    const previous = this.lastPublishedTranscript.get(webContentsId);
    if (payload) {
      if (
        previous &&
        previous.workspaceId === payload.workspaceId &&
        previous.sessionId === payload.sessionId &&
        previous.transcript === payload.transcript &&
        previous.schemaInfo === payload.schemaInfo
      ) {
        return;
      }
    } else if (previous === null) {
      return;
    }
    const projected = this.projectState(webContentsId);
    if (payload) {
      if (
        projected.selectedWorkspaceId !== payload.workspaceId ||
        projected.selectedSessionId !== payload.sessionId
      ) {
        return;
      }
    } else if (projected.selectedSessionId) {
      return;
    }
    this.lastPublishedTranscript.set(webContentsId, payload);
    const patch = previous && payload ? selectedTranscriptPatch(previous, payload) : undefined;
    if (patch && patch.deleteCount === 0 && patch.rows.length === 0) {
      return;
    }
    window.webContents.send(desktopIpc.selectedTranscriptChanged, patch ?? payload);
  }

  // The window could not apply a patch (it reloaded or missed one), so send it the whole transcript.
  resendSelectedTranscript(sender: HostContents): void {
    const window = this.windowByContents.get(sender.id);
    if (!window || !this.windows.has(window)) {
      return;
    }
    this.lastPublishedTranscript.delete(window.webContents.id);
    this.publishTranscriptSoon(window);
  }

  private publishTranscriptSoon(window: HostWindow): void {
    void this.publishTranscript(window).catch((error: unknown) => {
      console.error("[window-owner] failed to publish selected transcript", error);
    });
  }

  private setActiveWindow(window: HostWindow): void {
    if (window.isDestroyed()) {
      return;
    }
    this.activeWindow = window;
    this.options.onActiveWindowChanged?.(window);
  }

  private applyViewToStateOwner(webContentsId: number): void {
    const view = this.views.get(webContentsId) ?? viewFromState(this.stateOwner.snapshot());
    this.stateOwner.applyView(view);
  }

  private applyActivation(window: HostWindow): void {
    this.setActiveWindow(window);
    this.applyViewToStateOwner(window.webContents.id);
    this.stateOwner.handleWindowActivation();
    this.views.set(window.webContents.id, viewFromState(this.stateOwner.snapshot()));
  }

  private applyDeferredActivation(): boolean {
    const webContentsId = this.deferredActivationWindowId;
    this.deferredActivationWindowId = undefined;
    if (webContentsId === undefined) {
      return false;
    }
    const window = [...this.windows].find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.id === webContentsId,
    );
    if (!window || !canPublishToWindow(window)) {
      return false;
    }
    this.applyActivation(window);
    return true;
  }

  private restoreForegroundUnlessSender(senderWindowId: number | undefined): void {
    const foregroundWindow = this.foreground();
    if (!foregroundWindow || foregroundWindow.webContents.id === senderWindowId) {
      return;
    }
    this.applyViewToStateOwner(foregroundWindow.webContents.id);
    this.stateOwner.emit();
  }

  private enqueueAction<T>(action: () => Promise<T>): Promise<T> {
    return this.actionQueue.run(action);
  }

  private beginAction(window: HostWindow | null | undefined, options: WindowActionOptions) {
    const liveWindow = window && !window.isDestroyed() ? window : undefined;
    const webContentsId = liveWindow?.webContents.id;
    const foregroundWindow = this.foreground();
    const senderIsForeground = Boolean(
      liveWindow && foregroundWindow?.webContents.id === liveWindow.webContents.id,
    );
    const windowIsFocused =
      Boolean(liveWindow?.isFocused()) || senderIsForeground || options.forceActiveWindow === true;
    if (liveWindow && webContentsId !== undefined) {
      if (windowIsFocused) {
        this.setActiveWindow(liveWindow);
      }
      this.applyViewToStateOwner(webContentsId);
    }
    const previousActionWindowId = this.activeActionWindowId;
    this.activeActionWindowId = webContentsId;
    return { window: liveWindow, webContentsId, previousActionWindowId };
  }

  private finishStateAction(window: HostWindow, state: DesktopAppState): DesktopAppState {
    const webContentsId = window.webContents.id;
    const previousView = this.views.get(webContentsId);
    const projected = this.projectState(webContentsId, state, viewFromState(state), previousView);
    this.views.set(webContentsId, viewFromState(projected));
    this.publishState(window, projected);
    this.publishTranscriptSoon(window);
    return projected;
  }

  private endAction(
    senderWindowId: number | undefined,
    previousActionWindowId: number | undefined,
  ): void {
    this.activeActionWindowId = previousActionWindowId;
    if (!this.applyDeferredActivation()) {
      this.restoreForegroundUnlessSender(senderWindowId);
    }
  }

  private attachStatePublisher(window: HostWindow): void {
    const webContentsId = window.webContents.id;
    const startPublishing = () => {
      this.lastPublishedTranscript.delete(webContentsId);
      this.stopPublishingState.get(webContentsId)?.();
      this.stopPublishingTranscript.get(webContentsId)?.();
      this.stopPublishingExtensionUi.get(webContentsId)?.();
      this.stopPublishingExtensionUi.set(
        webContentsId,
        this.stateOwner.subscribeToExtensionUi((update) => {
          if (canPublishToWindow(window)) {
            window.webContents.send(desktopIpc.extensionUiChanged, update);
          }
        }),
      );
      this.stopPublishingState.set(
        webContentsId,
        this.stateOwner.subscribe((state) => {
          this.publishState(window, state);
          this.publishTranscriptSoon(window);
        }),
      );
      this.stopPublishingTranscript.set(
        webContentsId,
        this.stateOwner.subscribeToSelectedTranscript(() => this.publishTranscriptSoon(window)),
      );
    };
    const stopPublishing = () => {
      this.stopPublishingState.get(webContentsId)?.();
      this.stopPublishingState.delete(webContentsId);
      this.stopPublishingTranscript.get(webContentsId)?.();
      this.stopPublishingTranscript.delete(webContentsId);
      this.stopPublishingExtensionUi.get(webContentsId)?.();
      this.stopPublishingExtensionUi.delete(webContentsId);
    };

    startPublishing();
    let recovering = false;
    window.webContents.on("render-process-gone", () => {
      recovering = true;
      stopPublishing();
    });
    window.webContents.on("did-finish-load", () => {
      if (!recovering) {
        return;
      }
      recovering = false;
      startPublishing();
      this.publishState(window);
      this.publishTranscriptSoon(window);
    });
  }

  private attachActivationTracking(window: HostWindow): void {
    const webContentsId = window.webContents.id;
    this.stopTrackingActivation.get(webContentsId)?.();
    const handleActivation = () => this.activate(window);
    const notifyFocused = () => {
      if (!window.isDestroyed()) window.webContents.send(desktopIpc.windowFocused);
    };
    const stop = () => {
      window.off("focus", notifyFocused);
      window.off("focus", handleActivation);
      window.off("show", handleActivation);
      window.off("restore", handleActivation);
    };
    window.on("focus", handleActivation);
    window.on("focus", notifyFocused);
    window.on("show", handleActivation);
    window.on("restore", handleActivation);
    this.stopTrackingActivation.set(webContentsId, stop);
  }
}
