import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunHealthFailure, RunHealthMonitor } from "../dist/run-health-monitor.js";
import { SessionRunHealth } from "../dist/session-run-health.js";

type HealthOptions = ConstructorParameters<typeof SessionRunHealth>[0];
type RunState = ReturnType<HealthOptions["getState"]>;
type Monitor = Pick<RunHealthMonitor, "progress" | "toolStarted" | "toolFinished" | "stop"> & {
  onInterrupt(failure: RunHealthFailure): void;
};

const STOP_TIMEOUT_MS = 5_000;
const failure: RunHealthFailure = { code: "TURN_STALLED", message: "Synthetic stalled run" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function currentMonitor(health: SessionRunHealth): Monitor {
  const { monitor } = health as unknown as { monitor: Monitor | undefined };
  assert.ok(monitor, "expected an active monitor");
  return monitor;
}

function harness(t: TestContext, options: { inactivityMs?: number; abort?: () => Promise<void> } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const abort = t.mock.fn(options.abort ?? (async () => {}));
  const session = { isStreaming: true, abort };
  const agentSession = session as unknown as AgentSession;
  const state: RunState = {
    session: agentSession,
    closed: false,
    promptStarting: true,
    awaitingSettle: true,
    waitingForInput: false,
  };
  const callbacks = {
    onInterrupt: t.mock.fn((_failure: RunHealthFailure) => {}),
    onCancellationUnconfirmed: t.mock.fn(() => {}),
    onStopConfirmed: t.mock.fn(() => {}),
    onAbortDeferred: t.mock.fn(() => {}),
    onAbortError: t.mock.fn((_error: unknown) => {}),
  };
  const health = new SessionRunHealth({
    inactivityMs: options.inactivityMs ?? 0,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    getState: () => state,
    ...callbacks,
  });
  t.after(() => {
    health.stopMonitoring();
    t.mock.timers.reset();
  });
  health.beforePrompt(agentSession);
  return {
    health, state, session, agentSession, abort, ...callbacks,
    observe(event: unknown) { health.observe(event as AgentSessionEvent); },
    // Drive the detector's notification boundary without retesting its thresholds.
    interrupt() { currentMonitor(health).onInterrupt(failure); },
  };
}

await test("message updates refresh progress only for meaningful text and thinking deltas", (t) => {
  const h = harness(t);
  const progress = t.mock.method(currentMonitor(h.health), "progress", () => {});
  for (const type of ["text_delta", "thinking_delta"]) {
    for (const delta of ["", " \t\n", "\u200b\u200e\u0000\u001b"]) {
      h.observe({ type: "message_update", assistantMessageEvent: { type, delta } });
      assert.equal(progress.mock.callCount(), 0, `${type}: ${JSON.stringify(delta)}`);
    }
  }
  for (const type of ["text_start", "text_end", "thinking_start", "toolcall_delta"]) {
    h.observe({ type: "message_update", assistantMessageEvent: { type, delta: "visible" } });
  }
  assert.equal(progress.mock.callCount(), 0);
  for (const type of ["text_delta", "thinking_delta"]) {
    h.observe({ type: "message_update", assistantMessageEvent: { type, delta: " \u200b字\n" } });
  }
  assert.equal(progress.mock.callCount(), 2);
  h.health.progress();
  assert.equal(progress.mock.callCount(), 3, "explicit progress also reaches the active monitor");
});

await test("tool updates distinguish meaningful strings, finite numbers and populated objects", (t) => {
  const h = harness(t);
  const progress = t.mock.method(currentMonitor(h.health), "progress", () => {});
  for (const partialResult of [undefined, null, false, true, "", " \n\u200b\u0000", NaN, Infinity, -Infinity, {}, []]) {
    h.observe({ type: "tool_execution_update", partialResult });
    assert.equal(progress.mock.callCount(), 0, String(partialResult));
  }
  const meaningful = ["output", "\u200b字", 0, -2, { content: [] }, ["output"]];
  for (const [index, partialResult] of meaningful.entries()) {
    h.observe({ type: "tool_execution_update", partialResult });
    assert.equal(progress.mock.callCount(), index + 1);
  }
});

await test("tool lifecycle forwards identifiers, inputs, persisted output and error status", (t) => {
  const h = harness(t);
  const monitor = currentMonitor(h.health);
  const started = t.mock.method(monitor, "toolStarted", () => {});
  const finished = t.mock.method(monitor, "toolFinished", () => {});
  const args = { path: "file" };
  const content = [{ type: "text", text: "result" }];
  const details = { exitCode: 1 };
  h.observe({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args });
  h.observe({
    type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: true,
    result: { content, details, transient: "exclude from persisted output" },
  });
  h.observe({ type: "tool_execution_end", toolCallId: "read-2", result: null, isError: false });
  assert.deepEqual(started.mock.calls.map((call) => call.arguments), [["read-1", "read", args]]);
  assert.deepEqual(finished.mock.calls.map((call) => call.arguments), [
    ["read-1", { content, details }, true],
    ["read-2", {}, false],
  ]);
});

await test("nested tool, message and settled events do not reach or stop the monitor", (t) => {
  const h = harness(t);
  const monitor = currentMonitor(h.health);
  const progress = t.mock.method(monitor, "progress", () => {});
  const started = t.mock.method(monitor, "toolStarted", () => {});
  const finished = t.mock.method(monitor, "toolFinished", () => {});
  const stopped = t.mock.method(monitor, "stop");
  for (const event of [
    { type: "tool_execution_start", toolCallId: "nested", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "nested", result: {}, isError: false },
    { type: "tool_execution_update", partialResult: "output" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "output" } },
    { type: "agent_settled", aborted: false },
  ]) h.observe({ ...event, parentToolCallId: "parent" });
  assert.equal(started.mock.callCount(), 0);
  assert.equal(finished.mock.callCount(), 0);
  assert.equal(progress.mock.callCount(), 0);
  assert.equal(stopped.mock.callCount(), 0);
  assert.equal(currentMonitor(h.health), monitor);
  h.observe({ type: "tool_execution_update", parentToolCallId: "", partialResult: "top-level" });
  assert.equal(progress.mock.callCount(), 1, "an empty parent ID is not a nested call");
});

await test("agent starts preserve a pending prompt monitor and restart settled or independent runs", (t) => {
  const h = harness(t);
  const first = currentMonitor(h.health);
  h.observe({ type: "agent_start" });
  assert.equal(currentMonitor(h.health), first);
  h.state.promptStarting = false;
  h.observe({ type: "agent_start" });
  const independent = currentMonitor(h.health);
  assert.notEqual(independent, first);
  const stopped = t.mock.method(independent, "stop");
  h.observe({ type: "agent_settled", aborted: false });
  assert.equal(stopped.mock.callCount(), 1);
  h.state.promptStarting = true;
  h.observe({ type: "agent_start" });
  assert.notEqual(currentMonitor(h.health), independent, "settlement allows a new monitor during prompt startup");
  h.health.stopMonitoring();
  h.state.session = undefined;
  h.observe({ type: "agent_start" });
  assert.doesNotThrow(() => h.health.progress());
  assert.equal((h.health as unknown as { monitor: unknown }).monitor, undefined);
});

await test("prompt completion monitors through settlement but stops handled inputs and disposal", (t) => {
  const h = harness(t);
  const first = currentMonitor(h.health);
  const stopped = t.mock.method(first, "stop");
  h.state.promptStarting = false;
  h.health.promptFinished();
  assert.equal(currentMonitor(h.health), first);
  assert.equal(stopped.mock.callCount(), 0);
  h.state.awaitingSettle = false;
  h.health.promptFinished();
  assert.equal(stopped.mock.callCount(), 1);
  h.health.progress();
  h.health.beforePrompt(h.agentSession);
  const nextStopped = t.mock.method(currentMonitor(h.health), "stop");
  h.health.dispose();
  assert.equal(nextStopped.mock.callCount(), 1);
  assert.doesNotThrow(() => h.health.dispose());
});

await test("waitingForInput is read live by the monitor and suspends inactivity", (t) => {
  const h = harness(t, { inactivityMs: 2_000 });
  t.mock.timers.tick(1_000);
  h.state.waitingForInput = true;
  for (let index = 0; index < 4; index += 1) t.mock.timers.tick(1_000);
  assert.equal(h.onInterrupt.mock.callCount(), 0);
  h.state.waitingForInput = false;
  t.mock.timers.tick(1_000);
  assert.equal(h.onInterrupt.mock.callCount(), 1);
  assert.equal(h.health.failure?.code, "TURN_STALLED");
});

await test("abort resolution and every run-state gate are required to confirm cancellation", async (t) => {
  for (const blocker of ["promptStarting", "awaitingSettle", "isStreaming"] as const) {
    await t.test(blocker, async (t) => {
      const pending = deferred();
      const h = harness(t, { abort: () => pending.promise });
      h.state.promptStarting = false;
      h.state.awaitingSettle = false;
      h.session.isStreaming = false;
      h.interrupt();
      assert.equal(h.health.isStopping, true);
      assert.equal(h.health.failure, failure);
      assert.equal(h.health.epoch, 1);
      assert.deepEqual(h.onInterrupt.mock.calls[0]?.arguments, [failure]);
      assert.equal(h.abort.mock.callCount(), 0, "abort is scheduled independently of the interrupt callback");
      h.interrupt();
      assert.equal(h.onInterrupt.mock.callCount(), 1, "duplicate notifications share the cancellation latch");
      assert.equal(h.health.epoch, 1);
      h.health.promptFinished();
      h.health.settlementHandled();
      assert.equal(h.health.isStopping, true, "an idle state alone cannot confirm an unfinished abort");
      for (const reuse of [() => h.health.assertReusable(), () => h.health.beforePrompt(h.agentSession), () => h.health.dispose()]) {
        assert.throws(reuse, /still stopping/);
      }
      await flush();
      assert.equal(h.abort.mock.callCount(), 1);
      if (blocker === "isStreaming") h.session.isStreaming = true;
      else h.state[blocker] = true;
      pending.resolve();
      await flush();
      assert.equal(h.health.isStopping, true, `${blocker} still prevents confirmation after abort resolves`);
      assert.equal(h.onStopConfirmed.mock.callCount(), 0);
      if (blocker === "isStreaming") h.session.isStreaming = false;
      else h.state[blocker] = false;
      if (blocker === "promptStarting") h.health.promptFinished();
      else h.health.settlementHandled();
      assert.equal(h.health.isStopping, false);
      assert.equal(h.onStopConfirmed.mock.callCount(), 1);
      assert.equal(h.health.failure, failure, "confirmation retains the failed run's diagnosis");
      h.health.promptFinished();
      h.health.settlementHandled();
      t.mock.timers.tick(STOP_TIMEOUT_MS);
      assert.equal(h.onStopConfirmed.mock.callCount(), 1);
      assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 0, "confirmation cancels the warning deadline");
      assert.doesNotThrow(() => h.health.assertReusable());
      h.health.beforePrompt(h.agentSession);
      assert.equal(h.health.failure, undefined, "the next prompt clears the diagnosis");
      assert.equal(h.health.epoch, 1, "starting a prompt does not undo cancellation invalidation");
    });
  }
});

await test("an already idle run confirms as soon as abort resolves", async (t) => {
  const h = harness(t);
  h.state.promptStarting = false;
  h.state.awaitingSettle = false;
  h.session.isStreaming = false;
  h.interrupt();
  await flush();
  assert.equal(h.health.isStopping, false);
  assert.equal(h.onStopConfirmed.mock.callCount(), 1);
  assert.equal(h.health.failure, failure);
  t.mock.timers.tick(STOP_TIMEOUT_MS);
  assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 0);
});

await test("abort is deferred only while a prompt is starting before streaming", async (t) => {
  for (const promptStarting of [false, true]) {
    for (const isStreaming of [false, true]) {
      await t.test(`promptStarting=${promptStarting}, isStreaming=${isStreaming}`, async (t) => {
        const h = harness(t);
        h.state.promptStarting = promptStarting;
        h.session.isStreaming = isStreaming;
        h.interrupt();
        assert.equal(h.onAbortDeferred.mock.callCount(), Number(promptStarting && !isStreaming));
        assert.equal(h.onInterrupt.mock.callCount(), 1);
        await flush();
        assert.equal(h.abort.mock.callCount(), 1, "pre-start deferral still attempts abort");
      });
    }
  }
});

await test("stale monitor callbacks cannot interrupt a replacement or stopped monitor", (t) => {
  const h = harness(t);
  const stale = currentMonitor(h.health).onInterrupt;
  h.health.beforePrompt(h.agentSession);
  stale(failure);
  const stopped = currentMonitor(h.health).onInterrupt;
  h.health.stopMonitoring();
  stopped(failure);
  assert.equal(h.onInterrupt.mock.callCount(), 0);
  assert.equal(h.abort.mock.callCount(), 0);
  assert.equal(h.health.isStopping, false);
  assert.equal(h.health.failure, undefined);
  assert.equal(h.health.epoch, 0);
  t.mock.timers.tick(STOP_TIMEOUT_MS);
  assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 0);
});

await test("monitor callbacks ignore a changed, removed or closed session", async (t) => {
  for (const change of ["changed", "removed", "closed"] as const) {
    await t.test(change, async (t) => {
      const h = harness(t);
      const notify = currentMonitor(h.health).onInterrupt;
      if (change === "changed") h.state.session = { isStreaming: true, abort: h.abort } as unknown as AgentSession;
      if (change === "removed") h.state.session = undefined;
      if (change === "closed") h.state.closed = true;
      notify(failure);
      await flush();
      assert.equal(h.onInterrupt.mock.callCount(), 0);
      assert.equal(h.abort.mock.callCount(), 0);
      assert.equal(h.health.isStopping, false);
      assert.equal(h.health.failure, undefined);
      assert.equal(h.health.epoch, 0);
      t.mock.timers.tick(STOP_TIMEOUT_MS);
      assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 0);
    });
  }
});

await test("a rejected abort retains the latch and reports the warning deadline exactly once", async (t) => {
  const error = new Error("synthetic abort rejection");
  const h = harness(t, { abort: async () => { throw error; } });
  h.state.promptStarting = false;
  h.state.awaitingSettle = false;
  h.session.isStreaming = false;
  h.interrupt();
  h.observe({ type: "agent_start" });
  assert.equal(h.health.failure, failure, "agent_start during cancellation must not reset the failed run");
  await flush();
  assert.deepEqual(h.onAbortError.mock.calls.map((call) => call.arguments), [[error]]);
  assert.equal(h.abort.mock.callCount(), 1);
  h.observe({ type: "agent_settled", aborted: true });
  h.health.settlementHandled();
  h.health.promptFinished();
  assert.equal(h.health.isStopping, true, "even settlement cannot confirm an abort that rejected");
  assert.equal(h.onStopConfirmed.mock.callCount(), 0);
  t.mock.timers.tick(STOP_TIMEOUT_MS - 1);
  assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 1);
  t.mock.timers.tick(STOP_TIMEOUT_MS);
  assert.equal(h.onCancellationUnconfirmed.mock.callCount(), 1);
  assert.equal(h.health.isStopping, true);
  assert.equal(h.health.failure, failure);
  assert.equal(h.health.epoch, 1);
  assert.throws(() => h.health.beforePrompt(h.agentSession), /still stopping/);
  assert.throws(() => h.health.dispose(), /still stopping/);
});

await test("invalid inactivity and stop timeouts are rejected before monitoring", (t) => {
  const h = harness(t);
  const callbacks: HealthOptions = {
    inactivityMs: 0,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    getState: () => h.state,
    onInterrupt: h.onInterrupt,
    onCancellationUnconfirmed: h.onCancellationUnconfirmed,
    onStopConfirmed: h.onStopConfirmed,
    onAbortDeferred: h.onAbortDeferred,
    onAbortError: h.onAbortError,
  };
  for (const inactivityMs of [-1, NaN, Infinity]) {
    assert.throws(() => new SessionRunHealth({ ...callbacks, inactivityMs }), RangeError);
  }
  for (const stopTimeoutMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => new SessionRunHealth({ ...callbacks, stopTimeoutMs }), RangeError);
  }
});
