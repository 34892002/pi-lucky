/**
 * Every environment variable the host runtime reads, plus the data-directory rules.
 *
 * Naming: the canonical names are `PI_LUCKY_*`. A few `PI_APP_*` names were inherited from
 * pi-gui's main process when the Electron tree was ported; they still work, but reading them
 * silently would let a pi-gui override point pi-lucky at pi-gui's profile. So the old names
 * go through `readWithLegacy()`, which warns once, and new code must use the pi-lucky names.
 *
 * pi's own variables (`PI_CODING_AGENT_DIR`, `PI_OFFLINE`, `PI_SESSION_DIR`, …) are the SDK's
 * contract and are deliberately not aliased here.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENV = {
  /** Profile directory: `ui-state.json`, `catalogs.json`, `attachments/`, `worktrees/`. */
  userDataDir: "PI_LUCKY_USER_DATA_DIR",
  /** pi-gui's name for the same thing; accepted for compatibility. */
  legacyUserDataDir: "PI_APP_USER_DATA_DIR",
  /** Workspaces to open on first launch, separated by the platform's path delimiter. */
  initialWorkspaces: "PI_LUCKY_INITIAL_WORKSPACES",
  legacyInitialWorkspaces: "PI_APP_INITIAL_WORKSPACES",
  /** Directory holding the node-pty native binding shipped beside the sidecar. */
  nodePtyDir: "PI_LUCKY_NODE_PTY_DIR",
  /** Stamped at build time from `neutralino.config.json`. */
  version: "PI_LUCKY_VERSION",
  /** Suppress OS notifications (smoke tests assert on the notification log instead). */
  testMode: "PI_LUCKY_TEST_MODE",
  legacyTestMode: "PI_APP_TEST_MODE",
  /** Append every notification as JSONL; used by the smoke tests. */
  notificationLogPath: "PI_LUCKY_NOTIFICATION_LOG_PATH",
  legacyNotificationLogPath: "PI_APP_NOTIFICATION_LOG_PATH",
  /** Override the orchestration supervision cadence, in milliseconds. */
  supervisionIntervalMs: "PI_LUCKY_ORCHESTRATION_SUPERVISION_INTERVAL_MS",
  legacySupervisionIntervalMs: "PI_APP_ORCHESTRATION_SUPERVISION_INTERVAL_MS",
} as const;

const deprecatedNames = new Set<string>();

function warnOnce(legacy: string, canonical: string): void {
  if (deprecatedNames.has(legacy)) {
    return;
  }
  deprecatedNames.add(legacy);
  console.warn(`[env] ${legacy} is pi-gui's name; use ${canonical} instead.`);
}

/** Next non-empty value; the first name wins. */
function firstSet(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** Canonical name first; the legacy name still works but says what to use instead. */
function readWithLegacy(canonical: keyof typeof ENV, legacy: keyof typeof ENV): string | undefined {
  const value = process.env[ENV[canonical]]?.trim();
  if (value) {
    return value;
  }
  const fallback = process.env[ENV[legacy]]?.trim();
  if (fallback) {
    warnOnce(ENV[legacy], ENV[canonical]);
  }
  return fallback;
}

/**
 * Executables that mean "running from source": anything else is the compiled sidecar.
 */
const RUNTIME_EXECUTABLES = new Set(["bun", "bun.exe", "bunx", "bunx.exe", "node", "node.exe"]);

/**
 * The folder the app was started from.
 *
 * Packaged builds put the sidecar in `<app>/binaries/`, so the sidecar's own path gives the
 * app folder. In dev (`bun run .../sidecar/main.ts`) the process is spawned with the repo root
 * as its working directory, so `data/` lands beside the sources instead of in the user profile.
 */
export function appRoot(): string {
  return isPackaged() ? path.dirname(path.dirname(process.execPath)) : process.cwd();
}

/**
 * True when the sidecar is the compiled binary rather than TypeScript source run by Bun.
 *
 * Derived from the executable instead of a flag the launcher would have to pass: Neutralino
 * spawns the sidecar through a shell, and `envs` quoting there is one more thing to get wrong.
 */
export function isPackaged(): boolean {
  return !RUNTIME_EXECUTABLES.has(path.basename(process.execPath).toLowerCase());
}

/** Portable default: `<app>/data`, next to the binary. */
export function portableDataDir(): string {
  return path.join(appRoot(), "data");
}

function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface UserDataDir {
  readonly dir: string;
  /** Where the answer came from, so the boot log can explain it. */
  readonly source: "env" | "portable" | "appdata";
  /** The portable attempt, for the fallback warning. */
  readonly portableDir: string;
}

/**
 * Resolve the profile directory.
 *
 * 1. `PI_LUCKY_USER_DATA_DIR` (or pi-gui's `PI_APP_USER_DATA_DIR`) — an explicit choice wins.
 * 2. `<app>/data` — portable by default: unzip anywhere, no writes to the user profile.
 * 3. `%APPDATA%\pi-lucky` — only when `<app>` is not writable (`Program Files`, a read-only
 *    mount), because a portable app that cannot write next to itself still has to start.
 */
export function resolveUserDataDir(): UserDataDir {
  const override = readWithLegacy("userDataDir", "legacyUserDataDir");
  const portableDir = portableDataDir();
  if (override) {
    return { dir: path.resolve(override), source: "env", portableDir };
  }
  if (isWritable(portableDir)) {
    return { dir: portableDir, source: "portable", portableDir };
  }
  const appData = firstSet("APPDATA") ?? path.join(os.homedir(), ".config");
  return { dir: path.join(appData, "pi-lucky"), source: "appdata", portableDir };
}

export function initialWorkspacePaths(): string[] {
  const raw = readWithLegacy("initialWorkspaces", "legacyInitialWorkspaces");
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function nodePtyDir(): string | undefined {
  return firstSet(ENV.nodePtyDir);
}

export function appVersion(fallback = "0.1.0"): string {
  return firstSet(ENV.version) ?? fallback;
}

export function testMode(): boolean {
  return readWithLegacy("testMode", "legacyTestMode") !== undefined;
}

export function notificationLogPath(): string | undefined {
  return readWithLegacy("notificationLogPath", "legacyNotificationLogPath");
}

export function supervisionIntervalMsOverride(): number | undefined {
  const raw = readWithLegacy("supervisionIntervalMs", "legacySupervisionIntervalMs");
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
