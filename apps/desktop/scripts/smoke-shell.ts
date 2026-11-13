/**
 * Shell smoke test: does the real window boot?
 *
 * Starts the Neutralino shell with a throw-away user data directory, attaches to the
 * WebView2 over CDP, and asserts the pieces that only exist when everything lined up:
 * the Neutralino client loaded, the sidecar answered, `window.piApp` was installed, and
 * React rendered without console errors.
 *
 * Requires a renderer build in development mode (`__PI_SIDECAR_DEV__`), i.e.
 * `vite build --mode development`.
 */
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const neuBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "neu.exe" : "neu");
const scratchDir = mkdtempSync(path.join(os.tmpdir(), "pi-lucky-shell-"));
const userDataDir = path.join(scratchDir, "user-data");
const logFile = path.join(scratchDir, "shell.log");
// A throw-away workspace: the repo folder may already be open in another pi instance
// (which locks its sessions) and its name can collide with UI copy in a rendered page.
const workspaceDir = path.join(scratchDir, "workspace");
// A real OS file handle: Neutralino only reads resources.neu when stdout/stderr are a
// plain file (Bun.file / pipes send it to the welcome page on Windows).
const logFd = openSync(logFile, "a");

/**
 * WebView2 serves CDP on a fixed port for its whole browser process lifetime, so a stale
 * instance from an earlier run can answer on that port with its own old page. Pick a free
 * port instead of a constant, and clear leftovers first.
 */
async function freePort(): Promise<number> {
  if (process.env.PI_LUCKY_DEBUG_PORT) {
    return Number(process.env.PI_LUCKY_DEBUG_PORT);
  }
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** The Neutralino window title from neutralino.config.json; CDP reports it as the page title. */
const WINDOW_TITLE = "pi-lucky";

const debugPort = await freePort();

for (const image of ["pi-lucky-win_x64.exe", "neutralino-win_x64.exe"]) {
  Bun.spawnSync({ cmd: ["taskkill", "/F", "/IM", image], stdout: "ignore", stderr: "ignore" });
}

// `PI_LUCKY_SHELL_BIN` runs a packaged build instead of `neu run`, which is how the
// release layout (sidecar next to the app binary, renderer from resources.neu) is checked.
const packagedBinary = process.env.PI_LUCKY_SHELL_BIN?.trim();
const shell = Bun.spawn(packagedBinary ? [packagedBinary] : [neuBin, "run"], {
  cwd: packagedBinary ? path.dirname(packagedBinary) : repoRoot,
  stdin: "ignore",
  // Redirect to a real fd rather than a pipe: a piped stdout/stderr changes how the
  // Neutralino shell starts up on Windows (it can end on the welcome page instead of
  // loading resources.neu), and a file keeps the diagnostics available either way.
  stdout: logFd,
  stderr: logFd,
  env: {
    ...process.env,
    PI_LUCKY_USER_DATA_DIR: userDataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
});

async function shutdown(code: number): Promise<never> {
  Bun.spawnSync({
    cmd: ["taskkill", "/F", "/T", "/PID", String(shell.pid)],
    stdout: "ignore",
    stderr: "ignore",
  });
  shell.kill();
  process.exit(code);
}

/** The shell's own output, so a hang can be diagnosed instead of guessed at. */
async function shellOutput(): Promise<string> {
  const file = Bun.file(logFile);
  if (!(await file.exists())) {
    return "";
  }
  return (await file.text()).trim();
}

interface Target {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly type: string;
  readonly webSocketDebuggerUrl?: string;
}

async function findPage(): Promise<Target> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = (await response.json()) as Target[];
      const page = targets.find(
        (target) => target.type === "page" && target.url.startsWith("http://127.0.0.1") && target.title === WINDOW_TITLE,
      );
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The debugger is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const seen = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    .then((response) => response.json() as Promise<Target[]>)
    .then((targets) => targets.map((target) => `${target.type}:${target.title}:${target.url}`))
    .catch((error: unknown) => [`list failed: ${String(error)}`]);
  throw new Error(
    `the shell never opened a debuggable window (port ${debugPort}); targets: ${seen.join(" | ")}` +
      `${await shellOutput().then((output) => (output ? `; output: ${output.slice(-400)}` : ""))}`,
  );
}

const page = await findPage();
const socket = new WebSocket(page.webSocketDebuggerUrl!);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
});

let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();
const consoleErrors: string[] = [];
const exceptions: string[] = [];

socket.addEventListener("message", (event) => {
  const frame = JSON.parse(String(event.data)) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  if (typeof frame.id === "number") {
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
    return;
  }
  if (frame.method === "Runtime.exceptionThrown") {
    const details = frame.params?.exceptionDetails as { text?: string; exception?: { description?: string } };
    exceptions.push(details?.exception?.description ?? details?.text ?? "unknown exception");
  }
  if (frame.method === "Runtime.consoleAPICalled") {
    const type = frame.params?.type as string;
    if (type === "error" || type === "assert") {
      const args = (frame.params?.args ?? []) as { value?: unknown; description?: string }[];
      consoleErrors.push(args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" "));
    }
  }
});

function send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve) => {
    pending.set(id, (frame) => resolve((frame as { result: T }).result));
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = await send<{
    result: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
}

await send("Runtime.enable");
await send("Log.enable");
// Re-run the boot assertions as a live expression so the timing is explicit: the bridge
// is installed before React mounts, and React fills `#root` on its first commit.
const deadline = Date.now() + 60_000;
let mounted = false;
while (Date.now() < deadline) {
  mounted = await evaluate<boolean>(
    "Boolean(window.piApp) && (document.querySelector('#root')?.childElementCount ?? 0) > 0",
  );
  if (mounted) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const report = {
  hasBridge: await evaluate<boolean>("Boolean(window.piApp)"),
  bridgeMethods: await evaluate<number>("window.piApp ? Object.keys(window.piApp).length : 0"),
  rootChildren: await evaluate<number>("document.querySelector('#root')?.childElementCount ?? 0"),
  text: (await evaluate<string>("document.body.innerText.slice(0, 400)")).trim(),
  consoleErrors,
  exceptions,
};

/**
 * Drive one full round trip through the renderer's own bridge: the call goes over HTTP to
 * the sidecar, the sidecar mutates the store, pushes `pi-gui:state-changed` back over the
 * websocket, and React re-renders. That is the whole Electron `ipcRenderer.invoke` ->
 * `webContents.send` loop, so it is the check that matters.
 */
async function addWorkspaceRoundTrip(): Promise<{ rendered: boolean; error?: string }> {
  mkdirSync(workspaceDir, { recursive: true });
  const folderName = path.basename(workspaceDir);
  const error = await evaluate<string | null>(
    `window.piApp.addWorkspacePath(${JSON.stringify(workspaceDir)}).then(() => null, (e) => String(e))`,
  );
  const waitUntil = Date.now() + 30_000;
  let rendered = false;
  while (Date.now() < waitUntil) {
    rendered = await evaluate<boolean>(
      `document.body.innerText.includes(${JSON.stringify(folderName)})`,
    );
    if (rendered) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return error ? { rendered, error } : { rendered };
}

const workspace = await addWorkspaceRoundTrip();
report.text = (await evaluate<string>("document.body.innerText.slice(0, 400)")).trim();
console.log(JSON.stringify({ workspace, textAfterWorkspace: report.text.slice(0, 200) }, null, 2));

console.log(JSON.stringify(report, null, 2));

const ok =
  report.hasBridge && report.rootChildren > 0 && exceptions.length === 0 && workspace.rendered;
socket.close();

if (!ok) {
  const output = await shellOutput();
  if (output) {
    console.error(output.slice(-2000));
  }
  await shutdown(1);
}

console.log("PASS: the shell boots, the sidecar answers, and the UI renders");
await shutdown(0);
