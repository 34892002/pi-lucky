/**
 * Parity audit against pi-gui's preload surface.
 *
 * `window.piApp` is generated from pi-gui's `reference/preload.ts`, so a method that exists
 * in the bridge map but is never mentioned by the host code is a silently dead channel —
 * the kind of gap `typecheck` cannot see. Run it after touching the bridge or the host IPC.
 *
 * The only accepted gaps are the channels listed in `LOCAL_PUSH_CHANNELS`
 * (`src/host/bridge.ts`): pushes pi-gui's main process raised itself, now raised by the shell.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dir, "..");
const hostDir = path.join(desktopRoot, "host");
const bridgeSourcePath = path.join(desktopRoot, "src", "host", "bridge.ts");
const bridgeMapPath = path.join(desktopRoot, "src", "host", "generated", "bridge-map.ts");
const contractsPath = path.join(desktopRoot, "contracts", "ipc.ts");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const [bridgeText, contractsText, bridgeSource, ...hostTexts] = await Promise.all([
  Bun.file(bridgeMapPath).text(),
  Bun.file(contractsPath).text(),
  Bun.file(bridgeSourcePath).text(),
  ...walk(hostDir).map((file) => Bun.file(file).text()),
]);
const hostSource = hostTexts.join("\n");

/** `piApp.<method>` → `[desktopIpc key, transport kind]`, as emitted by gen-bridge-map. */
const bridgeMethods = [...bridgeText.matchAll(/^ {2}(\w+):\s*\["(\w+)",\s*"(\w+)"\],$/gm)].map(
  (match) => ({ method: match[1], key: match[2], kind: match[3] }),
);

/** Every `desktopIpc` entry: camelCase key → channel string. */
const channels = new Map<string, string>();
for (const [, key, channel] of contractsText.matchAll(/^ {2}(\w+):\s*"([^"]+)",/gm)) {
  channels.set(key, channel);
}

/** Keys inside the `LOCAL_PUSH_CHANNELS` set literal in bridge.ts. */
const localPushKeys = new Set<string>();
const blockStart = bridgeSource.indexOf("const LOCAL_PUSH_CHANNELS");
const blockEnd = bridgeSource.indexOf("]);", blockStart);
for (const match of bridgeSource.slice(blockStart, blockEnd).matchAll(/desktopIpc\.(\w+)/g)) {
  localPushKeys.add(match[1]);
}

const kinds = bridgeMethods.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}, {});

const notInHost = bridgeMethods
  .filter((entry) => !hostSource.includes(`desktopIpc.${entry.key}`))
  .map((entry) => ({
    kind: entry.kind,
    method: entry.method,
    key: entry.key,
    channel: channels.get(entry.key) ?? entry.key,
    expected: localPushKeys.has(entry.key),
  }));

const gaps = notInHost.filter((entry) => !entry.expected);

console.log(
  JSON.stringify(
    {
      contractChannels: channels.size,
      bridgeMethods: bridgeMethods.length,
      byKind: kinds,
      localPushesOwnedByShell: notInHost
        .filter((entry) => entry.expected)
        .map((entry) => `${entry.kind} ${entry.method} -> ${entry.channel}`),
      gaps: gaps.map((entry) => `${entry.kind} ${entry.method} -> ${entry.channel}`),
    },
    null,
    1,
  ),
);

if (gaps.length > 0) {
  process.exitCode = 1;
}
