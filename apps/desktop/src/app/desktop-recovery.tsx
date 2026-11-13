import { Component, Fragment, type ReactNode } from "react";
import { useTranslation, type MessageKey, type Translate } from "../i18n";
import type { DesktopAppView, StateHydrationFailure } from "./desktop-app-state";

export type DesktopStartupSurfaceState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly failure: StateHydrationFailure;
      readonly retrying: boolean;
    }
  | { readonly kind: "crashed" };

export interface DesktopStartupCopy {
  readonly title: string;
  readonly body: string;
  readonly status: "loading" | "failed" | "crashed";
}

/** Startup copy as catalog keys: the language is only known once the app renders. */
interface StartupCopyKeys {
  readonly title: MessageKey;
  readonly body: MessageKey;
  readonly status: "loading" | "failed" | "crashed";
}

const LOADING_COPY: StartupCopyKeys = {
  title: "app.recovery.loading.title",
  body: "app.recovery.loading.body",
  status: "loading",
};

const STATE_FAILED_COPY: StartupCopyKeys = {
  title: "app.recovery.failed.title",
  body: "app.recovery.failed.body",
  status: "failed",
};

const BRIDGE_FAILED_COPY: StartupCopyKeys = {
  title: "app.recovery.failed.title",
  body: "app.recovery.bridgeFailed.body",
  status: "failed",
};

const CRASHED_COPY: StartupCopyKeys = {
  title: "app.recovery.crashed.title",
  body: "app.recovery.crashed.body",
  status: "crashed",
};

function startupCopy(keys: StartupCopyKeys, t: Translate): DesktopStartupCopy {
  return { title: t(keys.title), body: t(keys.body), status: keys.status };
}

export function startupSurfaceCopy(
  state: DesktopStartupSurfaceState,
  t: Translate,
): DesktopStartupCopy {
  if (state.kind === "loading") {
    return startupCopy(LOADING_COPY, t);
  }
  if (state.kind === "crashed") {
    return startupCopy(CRASHED_COPY, t);
  }
  if (state.failure.code === "bridge-unavailable") {
    return startupCopy(BRIDGE_FAILED_COPY, t);
  }
  return startupCopy(STATE_FAILED_COPY, t);
}

export function rendererBoundaryCopy(t: Translate): DesktopStartupCopy {
  return startupCopy(CRASHED_COPY, t);
}

interface DesktopStartupSurfaceProps {
  readonly state: DesktopStartupSurfaceState;
  readonly onRetry: () => void;
  readonly onRelaunch?: () => void;
}

export function DesktopStartupSurface({ state, onRetry, onRelaunch }: DesktopStartupSurfaceProps) {
  const { t } = useTranslation();
  const copy = startupSurfaceCopy(state, t);
  const retrying = state.kind === "failed" ? state.retrying : false;
  const showActions = copy.status !== "loading";
  const showRelaunch =
    Boolean(onRelaunch) &&
    (state.kind === "crashed" ||
      (state.kind === "failed" && state.failure.code !== "bridge-unavailable"));

  return (
    <div className="shell shell--loading">
      <main
        className="loading-card"
        data-testid="shell-status-card"
        data-status={copy.status}
        data-retrying={retrying ? "true" : "false"}
        data-failure={state.kind === "failed" ? state.failure.code : undefined}
      >
        <div className="loading-card__eyebrow">pi-lucky</div>
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        {showActions ? (
          <div className="loading-card__actions">
            <button
              className="button button--primary"
              data-testid="hydrate-retry"
              type="button"
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? t("app.recovery.retrying") : t("app.recovery.retry")}
            </button>
            {showRelaunch ? (
              <button
                className="button button--ghost"
                data-testid="hydrate-relaunch"
                type="button"
                onClick={onRelaunch}
              >
                {t("app.recovery.relaunch")}
              </button>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

interface RendererErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onRelaunch?: () => void;
}

interface RendererErrorBoundaryState {
  readonly hasError: boolean;
  readonly remountKey: number;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { hasError: false, remountKey: 0 };

  static getDerivedStateFromError(): Pick<RendererErrorBoundaryState, "hasError"> {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[renderer] render tree failed", error);
  }

  private readonly handleRetry = (): void => {
    this.setState((current) => ({
      hasError: false,
      remountKey: current.remountKey + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <DesktopStartupSurface
          state={{ kind: "crashed" }}
          onRetry={this.handleRetry}
          onRelaunch={this.props.onRelaunch}
        />
      );
    }
    return <Fragment key={this.state.remountKey}>{this.props.children}</Fragment>;
  }
}

export function toStartupSurfaceState(view: DesktopAppView): DesktopStartupSurfaceState {
  if (view.kind === "failed") {
    return view;
  }
  return { kind: "loading" };
}
