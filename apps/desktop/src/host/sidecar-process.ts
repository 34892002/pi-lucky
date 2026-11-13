/**
 * Starts and supervises the Bun sidecar process.
 *
 * Electron shipped the main process with the app; Neutralino has no backend runtime,
 * so the shell spawns one. Neutralino reports child output as `spawnedProcess`
 * events, which is how we learn the loopback port and the per-launch bearer token —
 * nothing is written to a predictable location that another process could read.
 */
import { neutralino, type SpawnedProcess } from "./neutralino";

export interface SidecarEndpointInfo {
  readonly port: number;
  readonly token: string;
  readonly version: string;
}

export interface SidecarProcessOptions {
  /** Absolute path to the sidecar binary, or the dev command that runs `main.ts`. */
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Milliseconds to wait for the READY handshake. */
  readonly readyTimeoutMs?: number;
  readonly onExit?: (code: number | null) => void;
  readonly onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

const READY_PREFIX = "PI_LUCKY_READY ";
const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface RunningSidecar {
  readonly endpoint: SidecarEndpointInfo;
  stop(): Promise<void>;
}

export async function startSidecar(options: SidecarProcessOptions): Promise<RunningSidecar> {
  const api = neutralino();
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  let bufferedOut = "";
  let bufferedErr = "";
  let resolveReady: (endpoint: SidecarEndpointInfo) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<SidecarEndpointInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let process: SpawnedProcess | undefined;

  const handleOutput = (data: string, stream: "stdout" | "stderr") => {
    const buffer = (stream === "stdout" ? bufferedOut : bufferedErr) + data;
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop() ?? "";
    if (stream === "stdout") {
      bufferedOut = rest;
    } else {
      bufferedErr = rest;
    }
    for (const line of lines) {
      if (!line) {
        continue;
      }
      if (line.startsWith(READY_PREFIX)) {
        try {
          resolveReady(JSON.parse(line.slice(READY_PREFIX.length)) as SidecarEndpointInfo);
        } catch (error) {
          rejectReady(new Error(`malformed sidecar handshake: ${line}`));
          void error;
        }
        continue;
      }
      options.onLog?.(line, stream);
    }
  };

  const onSpawnedProcess = (event: CustomEvent) => {
    const detail = event.detail as { action?: string; data?: string } | undefined;
    if (!detail?.action) {
      return;
    }
    if (detail.action === "stdOut") {
      handleOutput(detail.data ?? "", "stdout");
      return;
    }
    if (detail.action === "stdErr") {
      handleOutput(detail.data ?? "", "stderr");
      return;
    }
    if (detail.action === "exit") {
      rejectReady(new Error("the sidecar exited before it was ready"));
      options.onExit?.(null);
    }
  };
  await api.events.on("spawnedProcess", onSpawnedProcess);
  const unsubscribe = () => {
    void api.events.off("spawnedProcess", onSpawnedProcess).catch(() => undefined);
  };

  try {
    process = await api.os.spawnProcess(options.command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { envs: options.env } : {}),
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`the sidecar did not report ready within ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);
  });

  try {
    const endpoint = await Promise.race([ready, timeout]);
    const processId = process.id;
    return {
      endpoint,
      stop: async () => {
        unsubscribe();
        try {
          await api.os.updateSpawnedProcess(processId, "exit");
        } catch {
          // Already gone: nothing to stop.
        }
      },
    };
  } catch (error) {
    unsubscribe();
    rejectReady(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
