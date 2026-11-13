import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { sessionKey, type SessionDriverEvent, type SessionQueuedMessage, type SessionRef, type TurnCaptureBoundary } from "@pi-gui/session-driver";
import { SessionSupervisor } from "../dist/index.js";
import type { RunHealthFailure, RunHealthMonitor } from "../dist/run-health-monitor.js";
import type { SessionRunHealth } from "../dist/session-run-health.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  // Drain the abort/listener promise chains without introducing wall-clock timers.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function syntheticSession(id: string, abort: () => Promise<void>) {
  const callbacks: Array<(event: unknown) => void> = [];
  return {
    sessionId: id,
    isStreaming: true,
    messages: [],
    sessionManager: { getSessionFile: () => undefined, getBranch: () => [] },
    abort,
    callbacks,
    clearQueue() {},
    getSteeringMessages: (): string[] => [],
    getFollowUpMessages: (): string[] => [],
    async steer(_text: string) {},
    async followUp(_text: string) {},
    async navigateTree(_entryId: string) { return { cancelled: false }; },
    async reload() {},
    subscribe(callback: (event: unknown) => void) {
      callbacks.push(callback);
      return () => {};
    },
    async bindExtensions() {},
  };
}

type SyntheticSession = ReturnType<typeof syntheticSession>;
type Cancellation = {
  session: SyntheticSession;
  abortFinished: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type SyntheticRecord = {
  ref: SessionRef;
  workspace: { workspaceId: string; path: string };
  title: string;
  status: string;
  updatedAt: string;
  preview?: string;
  runningRunId: string | undefined;
  session: SyntheticSession;
  runtime: { dispose(): Promise<void> };
  leasePath: string;
  closed: boolean;
  promptStarting: boolean;
  runAwaitingSettle: boolean;
  cancellationRequested: boolean;
  abortOnRunStart: boolean;
  queuedMessages: SessionQueuedMessage[];
  piQueueSync: Promise<void>;
  queueStepsPending: number;
  startedQueuedMessageIds: Set<string>;
  acceptedQueuedMessageIds: Set<string>;
  queuedStartFailed: boolean;
  runHealth?: SessionRunHealth;
  pendingHostUiRequests: Map<string, unknown>;
  listeners: Set<(event: SessionDriverEvent) => void>;
  eventQueue: Promise<void>;
};

interface SupervisorInternals {
  records: Map<string, SyntheticRecord>;
  createRunHealth(record: SyntheticRecord): SessionRunHealth;
  handleAgentEvent(record: SyntheticRecord, event: unknown): void;
  ensureRecord(ref: SessionRef): Promise<SyntheticRecord>;
  disposeRecordRuntime(record: SyntheticRecord): Promise<void>;
  rebindRuntimeSession(record: SyntheticRecord, session: SyntheticSession): Promise<void>;
  persistSnapshot(record: SyntheticRecord): Promise<void>;
  releaseSessionLease(record: SyntheticRecord): Promise<void>;
  markStoppedReply(record: SyntheticRecord, replyId: string | undefined): void;
  refreshUsage(record: SyntheticRecord): void;
  collectSessionCommands(session: SyntheticSession): unknown[];
  createExtensionUiContext(record: SyntheticRecord): object;
  createCommandContextActions(record: SyntheticRecord): {
    newSession(): Promise<unknown>;
    fork(entryId: string): Promise<unknown>;
    navigateTree(entryId: string): Promise<unknown>;
    switchSession(path: string): Promise<unknown>;
    reload(): Promise<unknown>;
  };
  claimSessionLease(path: string): Promise<string>;
  catalogs: {
    sessions: { listSessions(workspaceId: string): Promise<{ sessions: unknown[] }> };
    workspaces: { deleteWorkspace(workspaceId: string): Promise<void> };
  };
}

function health(record: SyntheticRecord): SessionRunHealth {
  assert.ok(record.runHealth);
  return record.runHealth;
}

function healthInternals(record: SyntheticRecord) {
  return health(record) as unknown as {
    monitor: RunHealthMonitor | undefined;
    monitorSettled: boolean;
    cancellation: Cancellation | undefined;
  };
}

function harness(t: TestContext) {
  const supervisor = new SessionSupervisor({ runInactivityTimeoutMs: 0, runStopTimeoutMs: 60_000 });
  const internal = supervisor as unknown as SupervisorInternals;
  // Keep the real health transitions, event mapper, queue, and idle handling. Only
  // persistence and unrelated SDK metadata/UI adapters are replaced for this unit test.
  const persist = t.mock.method(internal, "persistSnapshot", async () => {});
  const release = t.mock.method(internal, "releaseSessionLease", async () => {});
  t.mock.method(internal, "markStoppedReply", () => {});
  t.mock.method(internal, "refreshUsage", () => {});
  t.mock.method(internal, "collectSessionCommands", () => []);
  t.mock.method(internal, "createExtensionUiContext", () => ({}));
  const captureCommands = internal.createCommandContextActions.bind(internal);
  t.mock.method(internal, "createCommandContextActions", () => ({}));
  const warnings = t.mock.method(console, "warn", () => {});
  const timers: Array<{ timer: ReturnType<typeof setTimeout>; fire(): void }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    const timer = realSetTimeout(callback, delay);
    timers.push({ timer, fire() { realClearTimeout(timer); callback(); } });
    return timer;
  });
  const clear = t.mock.method(globalThis, "clearTimeout", realClearTimeout);
  const records: SyntheticRecord[] = [];
  t.after(() => {
    for (const record of records) health(record).stopMonitoring();
    for (const { timer } of timers) realClearTimeout(timer);
  });

  function record(id = "session", abort: () => Promise<void> = () => new Promise(() => {})) {
    const events: SessionDriverEvent[] = [];
    const abortSpy = t.mock.fn(abort);
    const dispose = t.mock.fn(async () => {});
    const session = syntheticSession(id, abortSpy);
    const record: SyntheticRecord = {
      ref: { workspaceId: "workspace", sessionId: id },
      workspace: { workspaceId: "workspace", path: "/synthetic/workspace" },
      title: "Health test",
      status: "running",
      updatedAt: new Date().toISOString(),
      runningRunId: `run-${id}`,
      session,
      runtime: { dispose },
      leasePath: `/synthetic/${id}.lease`,
      closed: false,
      promptStarting: false,
      runAwaitingSettle: true,
      cancellationRequested: false,
      abortOnRunStart: false,
      queuedMessages: [],
      piQueueSync: Promise.resolve(),
      queueStepsPending: 0,
      startedQueuedMessageIds: new Set(),
      acceptedQueuedMessageIds: new Set(),
      queuedStartFailed: false,
      pendingHostUiRequests: new Map(),
      listeners: new Set([(event) => { events.push(event); }]),
      eventQueue: Promise.resolve(),
    };
    records.push(record);
    internal.records.set(sessionKey(record.ref), record);
    record.runHealth = internal.createRunHealth(record);
    record.runHealth.beforePrompt(session as unknown as AgentSession);
    return { record, session, events, abort: abortSpy, dispose };
  }

  function repeat(record: SyntheticRecord, count = 30) {
    for (let index = 0; index < count; index += 1) {
      health(record).observe({
        type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: { path: "file" },
      });
      health(record).observe({
        type: "tool_execution_end", toolCallId: `read-${index}`, toolName: "read",
        result: { content: [{ type: "text", text: "same result" }] }, isError: false,
      });
    }
  }

  async function settle(record: SyntheticRecord) {
    record.session.isStreaming = false;
    internal.handleAgentEvent(record, {
      type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }],
    });
    internal.handleAgentEvent(record, { type: "agent_settled", aborted: false });
    await record.eventQueue;
    await flush();
  }

  return { supervisor, internal, record, repeat, settle, persist, release, warnings, timers, clear, captureCommands };
}

await test("automatic health failure reports one runFailed even when persistence and the event queue are blocked", async (t) => {
  const h = harness(t);
  const run = h.record();
  const blocked = deferred();
  h.persist.mock.mockImplementation(() => blocked.promise);
  run.record.eventQueue = blocked.promise;
  h.repeat(run.record, 29);
  assert.equal(health(run.record).isStopping, false);
  assert.equal(run.events.length, 0);
  h.repeat(run.record, 1);
  h.repeat(run.record, 60);
  await flush();

  assert.equal(run.abort.mock.callCount(), 1);
  assert.equal(run.record.status, "failed");
  assert.equal(health(run.record).failure?.code, "TOOL_LOOP_DETECTED");
  assert.equal(run.record.preview, health(run.record).failure?.message);
  assert.equal(run.events.length, 1);
  const failure = run.events[0];
  assert.equal(failure?.type, "runFailed");
  if (failure?.type === "runFailed") {
    assert.equal(failure.runId, "run-session");
    assert.deepEqual(failure.sessionRef, run.record.ref);
    assert.equal(failure.error, health(run.record).failure);
  }
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]!.timer.hasRef(), false, "the stop deadline cannot keep Node alive");
  blocked.resolve();
  await run.record.eventQueue;
});

await test("an abort that never resolves retains the latch, runtime and lease after the stop deadline", async (t) => {
  const h = harness(t);
  const run = h.record();
  const runtime = run.record.runtime;
  h.repeat(run.record);
  await flush();
  const stop = healthInternals(run.record).cancellation;
  assert.ok(stop);
  assert.equal(stop.abortFinished, false);

  // Even settlement and prompt completion cannot substitute for a confirmed abort.
  await h.settle(run.record);
  h.timers[0]!.fire();
  await run.record.eventQueue;
  assert.equal(healthInternals(run.record).cancellation, stop);
  assert.equal(run.events.filter((event) => event.type === "runFailed").length, 1);
  assert.equal(run.events.filter((event) => event.type === "runCompleted").length, 0);
  const notice = run.events.find((event) => event.type === "hostUiRequest");
  assert.equal(notice?.type, "hostUiRequest");
  if (notice?.type === "hostUiRequest") {
    assert.equal(notice.request.kind, "notify");
    assert.match(notice.request.message, /locked/);
  }
  await assert.rejects(h.internal.ensureRecord(run.record.ref), /still stopping/);
  await assert.rejects(h.supervisor.closeSession(run.record.ref), /not confirmed cancellation/);
  await assert.rejects(h.internal.disposeRecordRuntime(run.record), /cancellation is unconfirmed/);
  assert.equal(run.record.closed, false);
  assert.equal(run.record.runtime, runtime);
  assert.equal(run.record.session, run.session);
  assert.equal(run.record.leasePath, "/synthetic/session.lease");
  assert.equal(h.release.mock.callCount(), 0);
  assert.equal(run.dispose.mock.callCount(), 0);
  assert.equal(run.abort.mock.callCount(), 1);
});

await test("a synchronous abort throw is contained and keeps cancellation unconfirmed", async (t) => {
  const h = harness(t);
  const error = new Error("synchronous SDK abort failure");
  const run = h.record("throwing", () => { throw error; });
  assert.doesNotThrow(() => h.repeat(run.record));
  await flush();
  assert.equal(run.abort.mock.callCount(), 1);
  assert.equal(health(run.record).isStopping, true);
  const cancellation = healthInternals(run.record).cancellation;
  assert.ok(cancellation);
  assert.equal(cancellation.abortFinished, false);
  assert.equal(run.events.filter((event) => event.type === "runFailed").length, 1);
  assert.ok(h.warnings.mock.calls.some((call) => call.arguments[1] === error));
  await assert.rejects(h.internal.ensureRecord(run.record.ref), /still stopping/);
  assert.equal(h.release.mock.callCount(), 0);
  assert.equal(run.dispose.mock.callCount(), 0);
});

for (const last of ["abort", "settlement", "prompt"] as const) {
  await test(`cancellation clears only after abort, settlement and prompt completion (${last} finishes last)`, async (t) => {
    const h = harness(t);
    const abort = deferred();
    const run = h.record(last, () => abort.promise);
    run.record.promptStarting = true;
    h.repeat(run.record);
    await flush();
    const stop = healthInternals(run.record).cancellation;
    const failure = health(run.record).failure;
    assert.ok(stop);
    const finish = {
      async abort() { abort.resolve(); await flush(); },
      async settlement() { await h.settle(run.record); },
      async prompt() { run.record.promptStarting = false; health(run.record).promptFinished(); },
    };
    for (const gate of ["abort", "settlement", "prompt"] as const) {
      if (gate === last) continue;
      await finish[gate]();
      assert.equal(healthInternals(run.record).cancellation, stop, `still waiting for ${last}`);
      await assert.rejects(h.internal.ensureRecord(run.record.ref), /still stopping/);
    }
    await finish[last]();
    assert.equal(health(run.record).isStopping, false);
    assert.equal(run.record.runningRunId, undefined);
    assert.equal(run.record.status, "failed");
    assert.equal(health(run.record).failure, failure, "unlocking must preserve the diagnostic");
    assert.equal(await h.internal.ensureRecord(run.record.ref), run.record);
    assert.ok(h.clear.mock.calls.some((call) => call.arguments[0] === stop.timer));

    // A later successful outcome cannot overwrite the already reported health failure.
    await h.settle(run.record);
    assert.equal(health(run.record).failure, failure);
    assert.equal(run.record.status, "failed");
    assert.equal(run.events.filter((event) => event.type === "runFailed").length, 1);
    assert.equal(run.events.filter((event) => event.type === "runCompleted").length, 0);
    const count = run.events.length;
    h.timers[0]!.fire();
    await run.record.eventQueue;
    assert.equal(run.events.length, count, "a stale stop deadline cannot notify after unlocking");
  });
}

await test("abort and settlement flags do not unlock a session that still reports streaming", async (t) => {
  const h = harness(t);
  const run = h.record("streaming", async () => {});
  h.repeat(run.record);
  await flush();
  const stop = healthInternals(run.record).cancellation;
  assert.ok(stop?.abortFinished);
  run.record.runAwaitingSettle = false;
  health(run.record).settlementHandled();
  assert.equal(healthInternals(run.record).cancellation, stop);
  run.session.isStreaming = false;
  health(run.record).settlementHandled();
  assert.equal(health(run.record).isStopping, false);
});

await test("health failures and cancellation latches are independent across records", async (t) => {
  const h = harness(t);
  const first = h.record("first");
  const second = h.record("second", async () => {});
  h.repeat(first.record, 29);
  h.repeat(second.record, 29);
  h.repeat(first.record, 1);
  await flush();
  assert.equal(health(first.record).isStopping, true);
  assert.equal(health(second.record).failure, undefined);
  assert.equal(second.abort.mock.callCount(), 0);
  assert.equal(await h.internal.ensureRecord(second.record.ref), second.record);
  h.repeat(second.record, 1);
  await flush();
  assert.equal(health(second.record).isStopping, true);
  await h.settle(second.record);
  assert.equal(health(second.record).isStopping, false);
  assert.equal(health(first.record).isStopping, true);
  assert.equal(first.events.filter((event) => event.type === "runFailed").length, 1);
  assert.equal(second.events.filter((event) => event.type === "runFailed").length, 1);
  assert.deepEqual(first.events[0]?.sessionRef, first.record.ref);
  assert.deepEqual(second.events[0]?.sessionRef, second.record.ref);
});

await test("stale monitors and session callbacks cannot interrupt or settle a replacement", async (t) => {
  const h = harness(t);
  const run = h.record();
  await h.internal.rebindRuntimeSession(run.record, run.session);
  const oldCallback = run.session.callbacks[0]!;
  health(run.record).beforePrompt(run.session as unknown as AgentSession);
  const staleMonitor = healthInternals(run.record).monitor!;
  const failure: RunHealthFailure = { code: "TURN_STALLED", message: "stale failure" };
  const interrupt = (monitor: RunHealthMonitor) => {
    // Model a callback already dispatched before stop/replacement, bypassing the
    // monitor's own stopped check to exercise the controller's identity guards.
    (monitor as unknown as { onInterrupt(failure: RunHealthFailure): void }).onInterrupt(failure);
  };
  health(run.record).beforePrompt(run.session as unknown as AgentSession);
  interrupt(staleMonitor);
  assert.equal(health(run.record).failure, undefined, "monitor identity is checked within the same session");
  const previousSessionMonitor = healthInternals(run.record).monitor!;
  const replacementAbort = t.mock.fn(async () => {});
  const replacement = syntheticSession(run.session.sessionId, replacementAbort);
  await h.internal.rebindRuntimeSession(run.record, replacement);
  health(run.record).beforePrompt(replacement as unknown as AgentSession);
  const replacementMonitor = healthInternals(run.record).monitor;
  run.record.runningRunId = "replacement-run";
  interrupt(previousSessionMonitor);
  oldCallback({ type: "agent_settled", aborted: false });
  oldCallback({ type: "agent_start" });
  await flush();
  assert.equal(run.record.session, replacement);
  assert.equal(healthInternals(run.record).monitor, replacementMonitor);
  assert.equal(run.record.runningRunId, "replacement-run");
  assert.equal(run.record.runAwaitingSettle, true);
  assert.equal(health(run.record).isStopping, false);
  assert.equal(health(run.record).failure, undefined);
  assert.equal(run.events.length, 0);
  assert.equal(run.abort.mock.callCount(), 0);
  assert.equal(replacementAbort.mock.callCount(), 0);

  // Prove the current subscription still processes events, then guards closure.
  replacement.callbacks[0]!({ type: "agent_settled", aborted: false });
  await run.record.eventQueue;
  assert.equal(run.record.runAwaitingSettle, false);
  assert.equal(run.events.at(-1)?.type, "sessionUpdated");
  run.record.closed = true;
  const count = run.events.length;
  replacement.callbacks[0]!({ type: "agent_start" });
  await flush();
  assert.equal(run.events.length, count);
  assert.equal(run.record.runAwaitingSettle, false);
});

await test("a handled SDK input with no agent_start stops its prompt health monitor", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-health-handled-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let closeSession = async () => {};
  t.after(async () => {
    try {
      await closeSession();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Health tests must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    packages: [], compaction: { enabled: false }, cacheWarming: "off",
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "health-test": {
      baseUrl: "http://127.0.0.1:9/never-contact", apiKey: "LOCAL_TEST_CANARY",
      api: "openai-completions",
      models: [{ id: "handled", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    },
  } }));
  let runtime!: AgentSessionRuntime;
  let handled = 0;
  const provider = t.mock.fn(() => { throw new Error("Handled input must not reach the provider"); });
  const supervisor = new SessionSupervisor({
    agentDir, catalogFilePath: join(root, "catalogs.json"),
    runInactivityTimeoutMs: 60_000,
    createAgentSessionRuntimeImpl: async (options = {}) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...options,
        tools: [],
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions,
          extensionFactories: [
            ...(options.resourceLoaderOptions?.extensionFactories ?? []),
            (pi) => {
              pi.on("input", async () => {
                handled += 1;
                return { action: "handled" as const };
              });
            },
          ],
        },
      });
      runtime.session.agent.streamFunction = provider;
      return runtime;
    },
  });
  const { ref } = await supervisor.createSession(
    { workspaceId: "health-workspace", path: cwd },
    { initialModel: { provider: "health-test", modelId: "handled" } },
  );
  const internal = supervisor as unknown as SupervisorInternals;
  const record = internal.records.get(sessionKey(ref))!;
  const events: SessionDriverEvent[] = [];
  const sdkEvents: string[] = [];
  const unsubscribeSdk = runtime.session.subscribe((event) => { sdkEvents.push(event.type); });
  let promptMonitor: RunHealthMonitor | undefined;
  let stopCalls = 0;
  const unsubscribe = supervisor.subscribe(ref, (event) => {
    events.push(event);
    if (event.type === "sessionUpdated" && event.snapshot.status === "running" && !promptMonitor) {
      promptMonitor = healthInternals(record).monitor;
      assert.ok(promptMonitor);
      const stop = promptMonitor.stop.bind(promptMonitor);
      t.mock.method(promptMonitor, "stop", () => { stopCalls += 1; stop(); });
    }
  });
  closeSession = async () => {
    unsubscribeSdk();
    unsubscribe();
    health(record).stopMonitoring();
    await supervisor.closeSession(ref);
  };
  await supervisor.sendUserMessage(ref, { text: "Handle this input locally" });
  await record.eventQueue;
  assert.equal(handled, 1);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(sdkEvents.includes("agent_start"), false);
  assert.equal(record.promptStarting, false);
  assert.equal(record.runAwaitingSettle, false);
  assert.ok(promptMonitor);
  assert.ok(stopCalls > 0, "successful prompt completion must stop the watchdog without a settlement event");
  for (let index = 0; index < 30; index += 1) {
    promptMonitor.toolStarted(String(index), "read", { path: "file" });
    promptMonitor.toolFinished(String(index), "same", false);
  }
  await flush();
  assert.equal(health(record).isStopping, false);
  assert.equal(health(record).failure, undefined);
  assert.equal(events.some((event) => event.type === "runFailed"), false);
});

await test("agent_start after agent_settled refreshes health monitoring while promptStarting is still true", async (t) => {
  const h = harness(t);
  const run = h.record();
  run.record.promptStarting = true;
  const previousMonitor = healthInternals(run.record).monitor;
  h.repeat(run.record, 29);
  h.internal.handleAgentEvent(run.record, { type: "agent_settled", aborted: false });
  assert.equal(run.record.promptStarting, true);
  assert.equal(healthInternals(run.record).monitorSettled, true);
  h.internal.handleAgentEvent(run.record, { type: "agent_start" });
  assert.notEqual(healthInternals(run.record).monitor, previousMonitor);
  assert.equal(healthInternals(run.record).monitorSettled, false);
  assert.equal(run.record.runAwaitingSettle, true);
  h.repeat(run.record, 29);
  await flush();
  assert.equal(health(run.record).failure, undefined, "the prior run's 29 reads cannot carry over");
  h.repeat(run.record, 1);
  await flush();
  const failureEvent = run.events.find((event) => event.type === "runFailed");
  assert.equal(failureEvent?.error.code, "TOOL_LOOP_DETECTED", "the replacement monitor is active");
  assert.equal(run.abort.mock.callCount(), 1);
  assert.equal(run.events.filter((event) => event.type === "runFailed").length, 1);
});

await test("removeWorkspace rejects a quarantined record before deleting its catalog entry", async (t) => {
  const h = harness(t);
  const run = h.record();
  // Quarantine must be found among live records even if the catalog omits it.
  const list = t.mock.method(h.internal.catalogs.sessions, "listSessions", async () => ({ sessions: [] }));
  const remove = t.mock.method(h.internal.catalogs.workspaces, "deleteWorkspace", async () => {});
  h.repeat(run.record);
  await flush();
  await assert.rejects(h.supervisor.removeWorkspace("workspace"), /still stopping|cancellation is unconfirmed/);
  assert.equal(list.mock.callCount(), 1);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(h.internal.records.get(sessionKey(run.record.ref)), run.record);
  assert.equal(run.record.closed, false);
  assert.equal(h.release.mock.callCount(), 0);
  assert.equal(run.dispose.mock.callCount(), 0);
});

await test("previously captured extension commands reject during cancellation before touching the SDK", async (t) => {
  const h = harness(t);
  const run = h.record();
  const actions = h.captureCommands(run.record);
  const newSession = t.mock.fn(async () => ({ cancelled: false }));
  const fork = t.mock.fn(async () => ({ cancelled: false }));
  const switchSession = t.mock.fn(async () => ({ cancelled: false }));
  Object.assign(run.record.runtime, { newSession, fork, switchSession });
  const navigate = t.mock.method(run.session, "navigateTree");
  const reload = t.mock.method(run.session, "reload");
  const claim = t.mock.method(h.internal, "claimSessionLease", async () => "/synthetic/claim");
  h.repeat(run.record);
  await flush();
  for (const command of [
    () => actions.newSession(),
    () => actions.fork("entry"),
    () => actions.navigateTree("entry"),
    () => actions.switchSession("/synthetic/replacement.jsonl"),
    () => actions.reload(),
  ]) {
    // reload checks synchronously; the remaining actions reject async promises.
    await assert.rejects(async () => { await command(); }, /still stopping|cancellation is unconfirmed/);
  }
  for (const spy of [newSession, fork, switchSession, navigate, reload, claim]) {
    assert.equal(spy.mock.callCount(), 0);
  }
  assert.equal(health(run.record).isStopping, true);
});

await test("replaceQueuedMessages waiting in ensureRecord cannot refill queues across the run health epoch", async (t) => {
  const h = harness(t);
  const run = h.record("queue-epoch", async () => {});
  const message: SessionQueuedMessage = {
    id: "accepted", mode: "followUp", text: "Previously accepted follow-up",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  run.record.queuedMessages = [message];
  run.record.acceptedQueuedMessageIds.add(message.id);
  const sdkQueue = [message.text];
  const clear = t.mock.method(run.session, "clearQueue", () => { sdkQueue.length = 0; });
  const followUp = t.mock.method(run.session, "followUp", async (text: string) => { sdkQueue.push(text); });
  const entered = deferred();
  const resume = deferred();
  const ensure = t.mock.method(h.internal, "ensureRecord", async () => {
    entered.resolve();
    await resume.promise;
    return run.record;
  });
  const edit = h.supervisor.replaceQueuedMessages(run.record.ref, [message]);
  // Attach rejection handling before releasing any asynchronous work.
  const rejected = assert.rejects(edit, /Queued edit belongs to an interrupted run/);
  await entered.promise;
  const epoch = health(run.record).epoch;
  h.repeat(run.record);
  await run.record.piQueueSync;
  await flush();
  assert.equal(health(run.record).epoch, epoch + 1);
  assert.deepEqual(run.record.queuedMessages, []);
  assert.deepEqual(sdkQueue, []);
  assert.equal(clear.mock.callCount(), 1);
  await h.settle(run.record);
  assert.equal(health(run.record).isStopping, false, "test the epoch guard after quarantine has cleared");
  resume.resolve();
  await rejected;
  await run.record.piQueueSync.catch(() => {});
  assert.equal(ensure.mock.callCount(), 1);
  assert.deepEqual(run.record.queuedMessages, []);
  assert.deepEqual(sdkQueue, []);
  assert.equal(followUp.mock.callCount(), 0);
  assert.equal(run.record.queuedStartFailed, true);
  assert.equal(run.record.queueStepsPending, 0);
});

await test("SDK inactivity automatically aborts once, captures interruption and allows the next prompt", { timeout: 4_500 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-health-inactivity-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let closeSession = async () => {};
  let deadline: ReturnType<typeof setTimeout> | undefined;
  t.after(async () => {
    if (deadline) clearTimeout(deadline);
    try {
      await closeSession();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Health tests must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    packages: [], compaction: { enabled: false }, cacheWarming: "off",
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "health-test": {
      baseUrl: "http://127.0.0.1:9/never-contact", apiKey: "LOCAL_TEST_CANARY",
      api: "openai-completions",
      models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
    },
  } }));
  let runtime!: AgentSessionRuntime;
  let calls = 0;
  let aborts = 0;
  let observedSignal: AbortSignal | undefined;
  const boundaries: TurnCaptureBoundary[] = [];
  const supervisor = new SessionSupervisor({
    agentDir, catalogFilePath: join(root, "catalogs.json"),
    // The real monitor clamps its tick to one second; no mock clocks or direct interruption.
    runInactivityTimeoutMs: 10,
    onTurnCaptureBoundary: async (boundary) => { boundaries.push(structuredClone(boundary)); },
    createAgentSessionRuntimeImpl: async (options = {}) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] });
      runtime.session.agent.streamFunction = (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop", timestamp: Date.now(),
        };
        calls += 1;
        stream.push({ type: "start", partial: message });
        if (calls === 1) {
          const signal = options?.signal;
          assert.ok(signal, "the SDK must supply the cancellation signal");
          observedSignal = signal;
          const abort = () => {
            signal.removeEventListener("abort", abort);
            aborts += 1;
            const aborted: AssistantMessage = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
            stream.push({ type: "error", reason: "aborted", error: aborted });
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        } else {
          stream.push({ type: "done", reason: "stop", message: {
            ...message, content: [{ type: "text", text: "Recovered successfully" }],
          } });
        }
        return stream;
      };
      return runtime;
    },
  });
  const { ref } = await supervisor.createSession(
    { workspaceId: "health-workspace", path: cwd },
    { initialModel: { provider: "health-test", modelId: "scripted" } },
  );
  const record = (supervisor as unknown as SupervisorInternals).records.get(sessionKey(ref))!;
  const events: SessionDriverEvent[] = [];
  const unsubscribe = supervisor.subscribe(ref, (event) => { events.push(event); });
  closeSession = async () => {
    unsubscribe();
    health(record).stopMonitoring();
    await runtime.session.abort();
    await supervisor.closeSession(ref);
  };
  // Keep a referenced, bounded deadline while the production watchdog runs unrefed.
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("Automatic inactivity cancellation did not finish")), 3_500);
  });
  await Promise.race([supervisor.sendUserMessage(ref, { text: "Wait until automatically interrupted" }), expired]);
  assert.equal(health(record).isStopping, false, "awaiting the prompt must finish automatic cancellation");
  clearTimeout(deadline);
  await record.eventQueue;
  await record.piQueueSync;
  assert.equal(calls, 1);
  assert.equal(aborts, 1);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(runtime.session.isStreaming, false);
  assert.equal(record.promptStarting, false);
  assert.equal(record.runAwaitingSettle, false);
  assert.equal(record.status, "failed");
  const failures = events.filter((event) => event.type === "runFailed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.error.code, "TURN_STALLED");
  assert.equal(health(record).failure?.code, "TURN_STALLED");
  assert.equal(events.filter((event) => event.type === "runCompleted").length, 0);
  const abortedReply = runtime.session.messages.at(-1);
  assert.equal(abortedReply?.role, "assistant");
  assert.equal(abortedReply?.stopReason, "aborted");
  const interrupted = boundaries.filter((boundary) => boundary.closing);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.closing?.outcome, "interrupted");
  assert.equal(interrupted[0]?.closing?.reason, "settled");
  assert.equal(interrupted[0]?.runId, failures[0]?.runId);

  await supervisor.sendUserMessage(ref, { text: "Complete the next prompt" });
  await record.eventQueue;
  assert.equal(calls, 2);
  assert.equal(aborts, 1);
  assert.equal(health(record).isStopping, false);
  assert.equal(health(record).failure, undefined);
  assert.equal(record.status, "idle");
  const completedReply = runtime.session.messages.at(-1);
  assert.equal(completedReply?.role, "assistant");
  assert.equal(completedReply?.stopReason, "stop");
  assert.equal(events.filter((event) => event.type === "runFailed").length, 1);
  const completed = events.filter((event) => event.type === "runCompleted");
  assert.equal(completed.length, 1);
  assert.notEqual(completed[0]?.runId, failures[0]?.runId);
  assert.deepEqual(boundaries.flatMap((boundary) => boundary.closing ? [boundary.closing.outcome] : []), ["interrupted", "completed"]);
  assert.equal(fetch.mock.callCount(), 0);
});
