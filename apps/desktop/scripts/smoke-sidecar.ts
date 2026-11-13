/**
 * Sidecar smoke test: boot it exactly as the shell does, then talk to it the way the
 * renderer will. Fails loudly if the READY handshake, auth, push stream or a real
 * store-backed RPC stops working.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const entry = path.join(import.meta.dir, "..", "host", "sidecar", "main.ts");
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "pi-lucky-smoke-"));

const child = Bun.spawn(["bun", "run", entry], {
  cwd: path.join(import.meta.dir, "..", ".."),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, PI_LUCKY_USER_DATA_DIR: userDataDir },
});

function fail(message: string): never {
  console.error("FAIL:", message);
  child.kill();
  process.exit(1);
}

const decoder = new TextDecoder();
const reader = child.stdout.getReader();
let buffered = "";

async function readLine(predicate: (line: string) => boolean): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (predicate(line)) {
        return line;
      }
      console.log("  sidecar:", line);
      continue;
    }
    const { value, done } = await reader.read();
    if (done) {
      fail("sidecar exited before READY");
    }
    buffered += decoder.decode(value, { stream: true });
  }
  return fail("timed out waiting for sidecar output");
}

const ready = await readLine((line) => line.startsWith("PI_LUCKY_READY "));
const { port, token } = JSON.parse(ready.slice("PI_LUCKY_READY ".length)) as {
  port: number;
  token: string;
};
console.log("READY", { port, userDataDir });

const base = `http://127.0.0.1:${port}`;

const health = await fetch(`${base}/health`);
if (!health.ok) fail(`/health ${health.status}`);
console.log("health:", await health.text());

const unauthorized = await fetch(`${base}/rpc/${encodeURIComponent("pi-gui:state-request")}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ args: [] }),
});
if (unauthorized.status !== 401) fail(`expected 401 without token, got ${unauthorized.status}`);
console.log("auth: rejects requests without the token");

async function call(channel: string, args: unknown[] = []): Promise<unknown> {
  const response = await fetch(`${base}/rpc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ args }),
  });
  const body = (await response.json()) as { ok: boolean; value?: unknown; error?: unknown };
  if (!body.ok) fail(`${channel} failed: ${JSON.stringify(body.error)}`);
  return body.value;
}

const state = (await call("pi-gui:state-request")) as {
  workspaces: { id: string; path: string }[];
  revision: number;
};
console.log("state-request:", { workspaces: state.workspaces.length, revision: state.revision });

const ping = await call("app:ping");
console.log("ping:", ping);

// The push stream is how every renderer update arrives; prove a mutation reaches it.
const events = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`);
const pushed: string[] = [];
const pushedMessage = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no push within 15s")), 15_000);
  events.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as { channel: string };
    pushed.push(frame.channel);
    if (frame.channel === "pi-gui:state-changed") {
      clearTimeout(timer);
      resolve();
    }
  };
  events.onerror = () => reject(new Error("events socket errored"));
});
await new Promise((resolve) => events.addEventListener("open", resolve, { once: true }));
console.log("events: connected");

await call("pi-gui:add-workspace-path", [process.cwd()]);
await pushedMessage;
console.log("events: received", [...new Set(pushed)].join(", "));
events.close();

child.stdin.end();
await child.exited;
console.log("PASS: sidecar booted, authenticated, served state and pushed updates");
