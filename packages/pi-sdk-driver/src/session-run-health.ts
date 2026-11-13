import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RunHealthMonitor, type RunHealthFailure } from "./run-health-monitor.js";
import { persistedToolOutput } from "./session-supervisor-utils.js";

interface SessionRunState {
  session: AgentSession | undefined;
  closed: boolean;
  promptStarting: boolean;
  awaitingSettle: boolean;
  waitingForInput: boolean;
}

interface SessionRunHealthOptions {
  inactivityMs: number;
  stopTimeoutMs: number;
  getState: () => SessionRunState;
  onInterrupt: (failure: RunHealthFailure) => void;
  onCancellationUnconfirmed: () => void;
  onStopConfirmed: () => void;
  onAbortDeferred: () => void;
  onAbortError: (error: unknown) => void;
}

interface Cancellation {
  session: AgentSession;
  abortFinished: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Pi lifecycle adapter. The supervisor retains ownership of records, queues and leases. */
export class SessionRunHealth {
  private monitor: RunHealthMonitor | undefined;
  private monitorSettled = false;
  private cancellation: Cancellation | undefined;
  private failureValue: RunHealthFailure | undefined;
  private epochValue = 0;

  constructor(private readonly options: SessionRunHealthOptions) {
    if (!Number.isFinite(options.inactivityMs) || options.inactivityMs < 0 ||
        !Number.isFinite(options.stopTimeoutMs) || options.stopTimeoutMs <= 0) {
      throw new RangeError("Run health timeouts must be finite and non-negative (stop timeout must be positive).");
    }
  }

  get failure(): RunHealthFailure | undefined { return this.failureValue; }
  get isStopping(): boolean { return this.cancellation !== undefined; }
  /** Invalidates queue work and events accepted before automatic cancellation. */
  get epoch(): number { return this.epochValue; }

  beforePrompt(session: AgentSession): void {
    this.assertReusable();
    this.start(session);
  }

  observe(event: AgentSessionEvent): void {
    const state = this.options.getState();
    if (event.type === "agent_start" && (!state.promptStarting || this.monitorSettled) &&
        !this.isStopping && state.session) this.start(state.session);
    const monitor = this.monitor;
    if (!monitor) return;
    // Nested script calls are not separate model attempts.
    if ("parentToolCallId" in event && event.parentToolCallId) return;
    switch (event.type) {
      case "tool_execution_start":
        monitor.toolStarted(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_end":
        monitor.toolFinished(event.toolCallId, persistedToolOutput(event.result), event.isError);
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if ((delta.type === "text_delta" || delta.type === "thinking_delta") &&
            /[^\s\p{Cf}\p{Cc}]/u.test(delta.delta)) monitor.progress();
        break;
      }
      case "tool_execution_update": {
        const value = event.partialResult;
        const meaningful = typeof value === "string" ? /[^\s\p{Cf}\p{Cc}]/u.test(value)
          : typeof value === "number" ? Number.isFinite(value)
          : value && typeof value === "object" && Object.keys(value).length > 0;
        if (meaningful) monitor.progress();
        break;
      }
      case "agent_settled":
        this.monitorSettled = true;
        this.stopMonitoring();
        break;
    }
  }

  progress(): void { this.monitor?.progress(); }

  /** Call after the supervisor clears promptStarting, including handled inputs. */
  promptFinished(): void {
    if (!this.options.getState().awaitingSettle) this.stopMonitoring();
    this.confirmCancellation();
  }

  /** Call after applying Pi's settled event to the supervisor's run state. */
  settlementHandled(): void { this.confirmCancellation(); }

  stopMonitoring(): void {
    this.monitor?.stop();
    this.monitor = undefined;
  }

  assertReusable(): void {
    if (this.isStopping) {
      throw new Error("The previous run is still stopping; cancellation is unconfirmed. Wait, or restart the app.");
    }
  }

  dispose(): void {
    this.assertReusable();
    this.stopMonitoring();
  }

  private start(session: AgentSession): void {
    this.stopMonitoring();
    this.failureValue = undefined;
    const monitor = new RunHealthMonitor({
      inactivityMs: this.options.inactivityMs,
      isWaiting: () => this.options.getState().waitingForInput,
      onInterrupt: (failure) => {
        const state = this.options.getState();
        if (state.session === session && this.monitor === monitor && !state.closed) {
          this.interrupt(session, failure);
        }
      },
    });
    this.monitor = monitor;
    this.monitorSettled = false;
    monitor.start();
  }

  private interrupt(session: AgentSession, failure: RunHealthFailure): void {
    if (this.isStopping) return;
    this.failureValue = failure;
    const cancellation: Cancellation = { session, abortFinished: false, timer: undefined };
    this.cancellation = cancellation;
    this.epochValue += 1;
    cancellation.timer = setTimeout(() => {
      if (this.cancellation === cancellation) this.options.onCancellationUnconfirmed();
    }, this.options.stopTimeoutMs);
    cancellation.timer.unref();
    // Schedule cancellation independently of persistence and event listeners.
    void Promise.resolve().then(() => session.abort()).then(() => {
      if (this.cancellation !== cancellation) return;
      cancellation.abortFinished = true;
      this.confirmCancellation();
    }, (error: unknown) => this.options.onAbortError(error));
    const state = this.options.getState();
    if (state.promptStarting && !session.isStreaming) this.options.onAbortDeferred();
    this.options.onInterrupt(failure);
  }

  private confirmCancellation(): void {
    const cancellation = this.cancellation;
    const state = this.options.getState();
    if (!cancellation || !cancellation.abortFinished || state.promptStarting ||
        state.awaitingSettle || cancellation.session.isStreaming) return;
    if (cancellation.timer) clearTimeout(cancellation.timer);
    this.cancellation = undefined;
    this.stopMonitoring();
    this.options.onStopConfirmed();
  }
}
