import { createHash } from "node:crypto";

export interface RunHealthFailure {
  code: "TURN_STALLED" | "TOOL_LOOP_DETECTED";
  message: string;
  details?: unknown;
}

export interface RunHealthMonitorOptions {
  inactivityMs?: number;
  now?: () => number;
  onInterrupt: (failure: RunHealthFailure) => void;
  isWaiting?: () => boolean;
}

const DEFAULT_INACTIVITY_MS = 45 * 60_000;
const MAX_JSON_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 65_536;
const MAX_PENDING = 128;
const LOOP_THRESHOLD = 30;
const FAST_RESULT_MS = 30_000;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Hash complete, canonical JSON; reject anything we cannot compare safely. */
function jsonFingerprint(value: unknown): string | undefined {
  const hash = createHash("sha256");
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const emit = (text: string): void => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_JSON_BYTES) throw new Error("JSON byte limit");
    hash.update(text);
  };
  const string = (text: string): void => {
    if (text.length > MAX_JSON_BYTES) throw new Error("JSON string limit");
    emit(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error("JSON traversal limit");
    }
    if (item === null) return emit("null");
    if (typeof item === "string") return string(item);
    if (typeof item === "boolean") return emit(String(item));
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) {
      return emit(String(item));
    }
    if (typeof item !== "object") throw new Error("Unsupported JSON value");
    if (ancestors.has(item)) throw new Error("Cyclic JSON");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new Error("Unsupported JSON object");
    }
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_JSON_NODES || keys.some((key) => typeof key !== "string")) {
      throw new Error("Unsupported JSON keys");
    }
    ancestors.add(item);
    if (array) {
      if (item.length > MAX_JSON_NODES || keys.length !== item.length + 1) {
        throw new Error("Sparse or extended JSON array");
      }
      emit("[");
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("Unsupported JSON array entry");
        }
        if (index > 0) emit(",");
        visit(descriptor.value, depth + 1);
      }
      emit("]");
    } else {
      emit("{");
      const sorted = (keys as string[]).sort();
      for (let index = 0; index < sorted.length; index += 1) {
        const key = sorted[index]!;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("Unsupported JSON property");
        }
        if (index > 0) emit(",");
        string(key);
        emit(":");
        visit(descriptor.value, depth + 1);
      }
      emit("}");
    }
    ancestors.delete(item);
  };
  try {
    visit(value, 0);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/** Session-local watchdog; it never invokes tools or changes a run itself. */
export class RunHealthMonitor {
  private readonly inactivityMs: number;
  private readonly now: () => number;
  private readonly onInterrupt: RunHealthMonitorOptions["onInterrupt"];
  private readonly isWaiting: () => boolean;
  private readonly pending = new Map<string, { name: string; inputHash: string }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private remainingMs = 0;
  private budgetAt = 0;
  // A consecutive streak needs only one fingerprint, never a growing history.
  private fingerprint: string | undefined;
  private repetitions = 0;
  private resultAt = 0;

  constructor(options: RunHealthMonitorOptions) {
    const inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    if (!Number.isFinite(inactivityMs) || inactivityMs < 0) {
      throw new RangeError("inactivityMs must be a finite non-negative number");
    }
    this.inactivityMs = inactivityMs;
    this.now = options.now ?? Date.now;
    this.onInterrupt = options.onInterrupt;
    this.isWaiting = options.isWaiting ?? (() => false);
  }

  /** Start a fresh budget and loop streak, including when already running. */
  start(): void {
    this.stop();
    this.running = true;
    this.remainingMs = this.inactivityMs;
    this.budgetAt = this.now();
    this.schedule();
  }

  /** Activity refreshes inactivity, independently of repeated tool results. */
  progress(): void {
    if (!this.running) return;
    this.remainingMs = this.inactivityMs;
    this.budgetAt = this.now();
  }

  toolStarted(id: string, name: string, input: unknown): void {
    if (!this.running) return;
    this.progress();
    this.pending.delete(id);
    if (!READ_ONLY_TOOLS.has(name)) {
      this.resetStreak();
      return;
    }
    const inputHash = jsonFingerprint(input);
    if (inputHash === undefined) {
      this.resetStreak();
      return;
    }
    if (this.pending.size >= MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value!);
      this.resetStreak();
    }
    this.pending.set(id, { name, inputHash });
  }

  toolFinished(id: string, output: unknown, isError: boolean): void {
    if (!this.running) return;
    this.progress();
    const tool = this.pending.get(id);
    this.pending.delete(id);
    if (!tool || isError || this.isWaiting()) {
      this.resetStreak();
      return;
    }
    const outputHash = jsonFingerprint(output);
    if (outputHash === undefined) {
      this.resetStreak();
      return;
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([tool.name, tool.inputHash, outputHash]))
      .digest("hex");
    const now = this.now();
    const gap = now - this.resultAt;
    this.repetitions = fingerprint === this.fingerprint && gap >= 0 && gap < FAST_RESULT_MS
      ? this.repetitions + 1
      : 1;
    this.fingerprint = fingerprint;
    this.resultAt = now;
    if (this.repetitions >= LOOP_THRESHOLD) {
      this.interrupt({
        code: "TOOL_LOOP_DETECTED",
        message: `Tool ${tool.name} returned the same result for the same input 30 times in succession.`,
        details: { toolName: tool.name, repetitions: LOOP_THRESHOLD },
      });
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.resetStreak();
  }

  private resetStreak(): void {
    this.fingerprint = undefined;
    this.repetitions = 0;
    this.resultAt = 0;
  }

  private interrupt(failure: RunHealthFailure): void {
    // Stop first so callback reentry (or a thrown callback) cannot notify twice.
    this.stop();
    this.onInterrupt(failure);
  }

  private schedule(): void {
    if (!this.running || this.inactivityMs === 0) return;
    const slice = Math.max(1_000, Math.min(60_000, this.remainingMs));
    const scheduledAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      const now = this.now();
      const gap = now - scheduledAt;
      if (!Number.isFinite(now) || gap < 0 || gap > slice + 30_000) {
        // Sleep, clock changes, and long event-loop pauses are not run stalls.
        this.remainingMs = this.inactivityMs;
        this.resetStreak();
      } else if (!this.isWaiting()) {
        this.remainingMs -= Math.max(0, now - this.budgetAt);
        if (this.remainingMs <= 0) {
          this.interrupt({
            code: "TURN_STALLED",
            message: `Run made no progress for ${this.inactivityMs} ms of active time.`,
            details: { inactivityMs: this.inactivityMs },
          });
          return;
        }
      }
      this.budgetAt = now;
      this.schedule();
    }, slice);
    this.timer.unref();
  }
}
