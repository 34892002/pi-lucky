/**
 * Terminal smoke test against the compiled sidecar.
 *
 * The integrated terminal is the one feature that depends on a native module
 * (node-pty → ConPTY), and it is the piece a single-file Bun build is most likely to
 * break. This drives it the way the renderer does: create a session, write a command,
 * read the pushed output.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const binary = path.join(repoRoot, "build", "binaries", "pi-lucky-sidecar.exe");
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "pi-lucky-terminal-"));
// A throw-away workspace: the repo folder may be open in another pi instance, which
// locks its sessions, so adding it as a workspace declines without an error.
const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "pi-lucky-terminal-ws-"));

const child = Bun.spawn([binary], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, PI_LUCKY_USER_DATA_DIR: userDataDir },
});

const decoder = new TextDecoder();
let buffered = "";
async function readReady(): Promise<{ port: number; token: string }> {
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.startsWith("PI_LUCKY_READY ")) {
        return JSON.parse(line.slice("PI_LUCKY_READY ".length));
      }
      continue;
    }
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("sidecar exited before READY");
    }
    buffered += decoder.decode(value, { stream: true });
  }
  throw new Error("timed out waiting for READY");
}

const { port, token } = await readReady();
const base = `http://127.0.0.1:${port}`;

async function call<T>(channel: string, args: unknown[] = []): Promise<T> {
  const response = await fetch(`${base}/rpc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ args }),
  });
  const body = (await response.json()) as { ok: boolean; value?: unknown; error?: { message: string } };
  if (!body.ok) {
    throw new Error(`${channel}: ${body.error?.message}`);
  }
  return body.value as T;
}

const state = await call<{ workspaces: { id: string; path: string }[] }>("pi-gui:state-request");
let workspaceId = state.workspaces[0]?.id;
if (!workspaceId) {
  const added = await call<{ workspaces: { id: string }[] }>("pi-gui:add-workspace-path", [
    workspaceDir,
  ]);
  workspaceId = added.workspaces[0]?.id;
}
if (!workspaceId) {
  throw new Error("no workspace available for the terminal");
}

const output: string[] = [];
const socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`);
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(String(event.data)) as { channel: string; payload?: unknown };
  if (frame.channel === "pi-gui:terminal-data") {
    const payload = frame.payload as { data?: string } | undefined;
    if (payload?.data) {
      output.push(payload.data);
    }
  }
  if (frame.channel === "pi-gui:terminal-error") {
    console.error("terminal error push:", frame.payload);
  }
});
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

interface TerminalPanel {
  readonly activeSessionId?: string;
  readonly sessions?: readonly { id: string; status: string }[];
}
const panel = await call<TerminalPanel | null>("pi-gui:terminal-create-session", [
  workspaceId,
  "smoke",
  { cols: 80, rows: 24 },
]);
console.log("create-session ->", JSON.stringify(panel));
const terminalId = panel?.activeSessionId ?? panel?.sessions?.[0]?.id;
if (!terminalId) {
  throw new Error("createSession did not return a terminal id");
}

// ConPTY drops input written before the shell has attached and drawn a prompt, so
// wait for output to stop growing before typing.
const idleDeadline = Date.now() + 20_000;
let lastLength = -1;
while (Date.now() < idleDeadline) {
  const length = output.join("").length;
  if (length > 0 && length === lastLength) {
    break;
  }
  lastLength = length;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
try {
  await call("pi-gui:terminal-write", [terminalId, "echo pi-lucky-terminal-ok\r"]);
  console.log("terminal-write: accepted");
} catch (error) {
  console.error("terminal-write failed:", String(error));
}
const deadline = Date.now() + 20_000;
let text = "";
while (Date.now() < deadline) {
  text = output.join("");
  if (text.includes("pi-lucky-terminal-ok")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

await call("pi-gui:terminal-close-session", [terminalId]).catch(() => undefined);
socket.close();
child.stdin.end();
await child.exited;

if (!text.includes("pi-lucky-terminal-ok")) {
  console.error("terminal output:", JSON.stringify(text.slice(-600)));
  throw new Error("the integrated terminal did not echo the command");
}
console.log("PASS: node-pty works inside the compiled sidecar");
