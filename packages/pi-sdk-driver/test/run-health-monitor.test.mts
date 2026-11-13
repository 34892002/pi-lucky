import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  RunHealthMonitor,
  type RunHealthFailure,
  type RunHealthMonitorOptions,
} from "../src/run-health-monitor.ts";

function harness(t: TestContext, options: Partial<RunHealthMonitorOptions> = {}, useDefaultBudget = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  let nextId = 0;
  const failures: RunHealthFailure[] = [];
  const monitor = new RunHealthMonitor({
    ...(useDefaultBudget ? {} : { inactivityMs: 0 }),
    now: () => now,
    onInterrupt: (failure) => failures.push(failure),
    ...options,
  });
  t.after(() => monitor.stop());
  monitor.start();
  return {
    monitor,
    failures,
    elapse(ms: number) { now += ms; },
    tick(ms: number, wallMs = ms) {
      now += wallMs;
      t.mock.timers.tick(ms);
    },
    repeat(count = 30, name = "read", input: unknown = { path: "file" }, output: unknown = "same") {
      for (let index = 0; index < count; index += 1) {
        const id = `result-${nextId++}`;
        monitor.toolStarted(id, name, input);
        monitor.toolFinished(id, output, false);
      }
    },
  };
}

await test("only the thirtieth exact fast read interrupts, even with progress events", (t) => {
  const h = harness(t);
  for (let index = 0; index < 29; index += 1) {
    h.repeat(1);
    h.monitor.progress();
    h.elapse(29_999);
  }
  assert.equal(h.failures.length, 0);
  h.repeat(1);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0]?.code, "TOOL_LOOP_DETECTED");
  assert.deepEqual(h.failures[0]?.details, { toolName: "read", repetitions: 30 });
  h.repeat(60);
  assert.equal(h.failures.length, 1);
});

await test("all four exact read-only names are eligible; names remain distinct", (t) => {
  const h = harness(t);
  for (const name of ["read", "grep", "find", "ls"]) {
    h.monitor.start();
    h.repeat(30, name);
  }
  assert.equal(h.failures.length, 4);
  h.monitor.start();
  for (let index = 0; index < 100; index += 1) {
    h.repeat(1, index % 2 === 0 ? "read" : "grep");
  }
  assert.equal(h.failures.length, 4);
});

await test("different complete inputs and outputs never form a streak", (t) => {
  const h = harness(t);
  const prefix = "x".repeat(100_000);
  for (let index = 0; index < 60; index += 1) {
    h.repeat(1, "read", { path: "file" }, prefix + index);
  }
  for (let index = 0; index < 60; index += 1) {
    h.repeat(1, "read", { path: prefix + index }, "same");
  }
  assert.equal(h.failures.length, 0);
  h.repeat(29);
  assert.equal(h.failures.length, 0);
  h.repeat(1);
  assert.equal(h.failures.length, 1);
});

await test("sorted nested JSON keys compare equally without losing array order", (t) => {
  const h = harness(t);
  for (let index = 0; index < 30; index += 1) {
    const value = index % 2 === 0 ? { b: [1, { y: 2, x: 3 }], a: true }
      : { a: true, b: [1, { x: 3, y: 2 }] };
    h.repeat(1, "read", value, value);
  }
  assert.equal(h.failures.length, 1);
  h.monitor.start();
  for (let index = 0; index < 60; index += 1) {
    h.repeat(1, "read", {}, index % 2 === 0 ? [1, 2] : [2, 1]);
  }
  assert.equal(h.failures.length, 1);
});

await test("a 30-second gap or backwards clock resets the repeated-read streak", (t) => {
  const h = harness(t);
  h.repeat(29);
  h.elapse(30_000);
  h.repeat(29);
  assert.equal(h.failures.length, 0);
  h.elapse(-1);
  h.repeat(29);
  assert.equal(h.failures.length, 0);
  h.repeat(1);
  assert.equal(h.failures.length, 1);
});

await test("mutating, unknown, namespaced and polling/status tools are excluded entirely", (t) => {
  const h = harness(t);
  for (const name of ["write", "edit", "bash", "terminal", "fetch", "poll", "status", "read_status", "grep_status", "mcp__read", "Read", "read "]) {
    h.repeat(100, name);
    h.repeat(29);
    assert.equal(h.failures.length, 0, name);
    h.repeat(1, name);
  }
  h.repeat(30);
  assert.equal(h.failures.length, 1);
});

await test("errors, unmatched completions and duplicate completions break streaks", (t) => {
  const h = harness(t);
  h.repeat(29);
  h.monitor.toolStarted("error", "read", { path: "file" });
  h.monitor.toolFinished("error", "same", true);
  h.repeat(29);
  h.monitor.toolFinished("unknown", "same", false);
  h.repeat(29);
  h.monitor.toolFinished("0", "same", false);
  h.repeat(29);
  assert.equal(h.failures.length, 0);
  h.repeat(1);
  assert.equal(h.failures.length, 1);
});

await test("pending refs evict the oldest at 128 and retain hashes instead of mutable input", (t) => {
  const h = harness(t);
  for (let index = 0; index < 129; index += 1) {
    h.monitor.toolStarted(String(index), "read", { path: "file" });
  }
  h.monitor.toolFinished("1", "same", false);
  h.monitor.toolFinished("128", "same", false);
  h.repeat(27);
  h.monitor.toolFinished("0", "same", false);
  assert.equal(h.failures.length, 0, "evicted completion cannot be the thirtieth result");
  const input = { path: "file" };
  h.monitor.toolStarted("snapshot", "read", input);
  input.path = "changed";
  h.monitor.toolFinished("snapshot", "same", false);
  h.repeat(29);
  assert.equal(h.failures.length, 1, "input is fingerprinted at tool start");
});

await test("huge, cyclic, deep and unsupported JSON is skipped without false positives", (t) => {
  const h = harness(t);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = "leaf";
  for (let index = 0; index < 70; index += 1) deep = { deep };
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() { throw new Error("must not invoke getters"); },
  });
  const unsupported: unknown[] = [
    "x".repeat(1_048_576), "😀".repeat(300_000), cycle, deep,
    undefined, BigInt(1), () => 1, Symbol("value"), NaN, Infinity, -0,
    new Date(), new Map(), new Set(), new Array(3), new Array(70_000).fill(null), getter,
    { value: undefined }, { [Symbol("key")]: 1 },
    new Proxy({}, { ownKeys() { throw new Error("uninspectable"); } }),
  ];
  for (const value of unsupported) {
    for (let index = 0; index < 30; index += 1) {
      h.monitor.toolStarted("input", "read", value);
      h.monitor.toolFinished("input", "same", false);
    }
    for (let index = 0; index < 30; index += 1) {
      h.monitor.toolStarted("output", "read", {});
      h.monitor.toolFinished("output", value, false);
    }
    assert.equal(h.failures.length, 0);
  }
  h.repeat(29);
  h.repeat(1, "read", {}, cycle);
  h.repeat(29);
  assert.equal(h.failures.length, 0, "skipped data breaks an existing streak");
  h.repeat(1);
  assert.equal(h.failures.length, 1);
});

await test("the 1 MiB JSON limit is inclusive and shared acyclic references are safe", (t) => {
  const h = harness(t);
  const shared = { value: "same" };
  h.repeat(30, "read", { a: shared, b: shared }, "x".repeat(1_048_574));
  assert.equal(h.failures.length, 1, "JSON quotes bring the output to exactly 1 MiB");
});

await test("default inactivity is 45 minutes, with slices no longer than 60 seconds", (t) => {
  const h = harness(t, {}, true);
  for (let minute = 0; minute < 44; minute += 1) h.tick(60_000);
  assert.equal(h.failures.length, 0);
  h.tick(60_000);
  assert.equal(h.failures[0]?.code, "TURN_STALLED");
  assert.deepEqual(h.failures[0]?.details, { inactivityMs: 45 * 60_000 });
});

await test("progress and tool lifecycle refresh inactivity independently of loop detection", (t) => {
  const h = harness(t, { inactivityMs: 2_000 });
  h.tick(1_000);
  h.monitor.progress();
  h.tick(1_000);
  h.monitor.toolStarted("tool", "write", {});
  h.tick(1_000);
  h.monitor.toolFinished("tool", "done", false);
  h.tick(1_000);
  assert.equal(h.failures.length, 0);
  h.tick(1_000);
  assert.equal(h.failures[0]?.code, "TURN_STALLED");
  h.tick(60_000);
  assert.equal(h.failures.length, 1);
});

await test("waiting at a tick suspends the budget and waiting results cannot trigger loops", (t) => {
  let waiting = false;
  const h = harness(t, { inactivityMs: 2_000, isWaiting: () => waiting });
  h.tick(1_000);
  waiting = true;
  for (let index = 0; index < 10; index += 1) h.tick(1_000);
  assert.equal(h.failures.length, 0);
  waiting = false;
  h.tick(1_000);
  assert.equal(h.failures[0]?.code, "TURN_STALLED", "pre-wait budget is preserved");
  h.monitor.start();
  waiting = true;
  h.repeat(100);
  waiting = false;
  h.repeat(29);
  assert.equal(h.failures.length, 1);
  h.repeat(1);
  assert.equal(h.failures[1]?.code, "TOOL_LOOP_DETECTED");
});

await test("wall gaps beyond expected slice plus 30s reset inactivity and repetition", (t) => {
  const h = harness(t, { inactivityMs: 2_000 });
  h.repeat(29);
  h.tick(2_000, 32_001);
  assert.equal(h.failures.length, 0);
  h.repeat(29);
  assert.equal(h.failures.length, 0);
  h.tick(1_000);
  h.tick(1_000);
  assert.equal(h.failures[0]?.code, "TURN_STALLED");
  h.monitor.start();
  h.tick(2_000, 32_000);
  assert.equal(h.failures.length, 2, "exactly 30 seconds of extra delay is still counted");
});

await test("backwards wall clocks reset inactivity rather than consuming budget", (t) => {
  const h = harness(t, { inactivityMs: 2_000 });
  h.tick(2_000, -1);
  assert.equal(h.failures.length, 0);
  h.tick(2_000);
  assert.equal(h.failures[0]?.code, "TURN_STALLED");
});

await test("zero inactivity creates no timers, while enabled timers are unrefed and stopped", (t) => {
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  let unrefed = 0;
  let cleared = 0;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    scheduled += 1;
    const timer = realSetTimeout(...args);
    const unref = timer.unref.bind(timer);
    timer.unref = () => { unrefed += 1; return unref(); };
    return timer;
  });
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
    cleared += 1;
    realClearTimeout(timer);
  });
  const monitor = new RunHealthMonitor({ inactivityMs: 0, onInterrupt: () => {} });
  t.after(() => monitor.stop());
  monitor.start();
  monitor.progress();
  assert.equal(scheduled, 0);
  monitor.stop();
  const enabled = new RunHealthMonitor({ inactivityMs: 1, onInterrupt: () => {} });
  t.after(() => enabled.stop());
  enabled.start();
  assert.equal(scheduled, 1);
  assert.equal(unrefed, 1);
  enabled.stop();
  assert.equal(cleared, 1);
});

await test("stop cancels ticks; start resets budgets, pending refs, streaks and once-only latch", (t) => {
  const h = harness(t, { inactivityMs: 2_000 });
  h.repeat(29);
  h.monitor.toolStarted("old", "read", { path: "file" });
  h.monitor.start();
  h.monitor.toolFinished("old", "same", false);
  h.repeat(29);
  assert.equal(h.failures.length, 0);
  h.repeat(1);
  assert.equal(h.failures.length, 1);
  h.monitor.start();
  h.tick(1_000);
  h.monitor.start();
  h.tick(1_000);
  assert.equal(h.failures.length, 1);
  h.monitor.stop();
  h.tick(60_000);
  h.repeat(100);
  assert.equal(h.failures.length, 1);
  h.monitor.start();
  h.tick(2_000);
  assert.equal(h.failures[1]?.code, "TURN_STALLED");
});

await test("callback exceptions and callback reentry cannot notify the same start twice", (t) => {
  let calls = 0;
  const h = harness(t, {
    onInterrupt() {
      calls += 1;
      h.monitor.progress();
      h.repeat(30);
      throw new Error("callback failure");
    },
  });
  assert.throws(() => h.repeat(30), /callback failure/);
  h.repeat(60);
  assert.equal(calls, 1);
  h.monitor.start();
  assert.throws(() => h.repeat(30), /callback failure/);
  assert.equal(calls, 2);
});

await test("invalid inactivity budgets are rejected", () => {
  for (const inactivityMs of [-1, NaN, Infinity]) {
    assert.throws(() => new RunHealthMonitor({ inactivityMs, onInterrupt: () => {} }), RangeError);
  }
});
