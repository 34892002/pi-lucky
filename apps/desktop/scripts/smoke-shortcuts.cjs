/**
 * Verifies the shell-level shortcut ownership (Ctrl+O, Ctrl+V) inside a real window.
 *
 * Run: bun run smoke:shortcuts
 * Asserts the two chords the shell owns (Ctrl+O, Ctrl+V outside editors) fire exactly once,
 * and that editors keep Ctrl+V for themselves. It rebuilds the renderer in development mode
 * first, because `neu run` serves resources/ from disk.
 */
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:net");
const { mkdirSync, existsSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const vite = path.join(repoRoot, "node_modules", ".bin", "vite.exe");
const neu = path.join(repoRoot, "node_modules", ".bin", "neu.exe");
const userDataDir = path.join(repoRoot, "tmp", "ud-shortcuts");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          !target.url.startsWith("devtools://"),
      );
      if (page) return page;
    } catch {
      // The port is not up yet.
    }
    await sleep(250);
  }
  throw new Error("no CDP page target appeared");
}

async function main() {
  mkdirSync(userDataDir, { recursive: true });
  console.log("[check] building the renderer (development mode)");
  const build = spawnSync(vite, ["build", "--mode", "development", "--config", "apps/desktop/vite.config.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (build.status !== 0) throw new Error(`vite build failed: ${build.status}`);

  for (const image of ["pi-lucky-win_x64.exe", "neutralino-win_x64.exe"]) {
    spawnSync("taskkill", ["/F", "/IM", image], { stdio: "ignore" });
  }

  const port = await freePort();
  const shell = spawn(neu, ["run"], {
    cwd: repoRoot,
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      PI_LUCKY_USER_DATA_DIR: userDataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });

  const cleanup = () => {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(shell.pid)], { stdio: "ignore" });
    } catch {}
    shell.kill();
  };

  try {
    const page = await waitForTarget(port);
    console.log("[check] target:", page.url);
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send("Runtime.enable");
    const probe = await send("Runtime.evaluate", { expression: "JSON.stringify({url: location.href, hasPi: !!window.piApp, text: document.body ? document.body.innerText.slice(0, 120) : \"\"})", returnByValue: true });
    console.log("[check] probe:", probe.result && probe.result.value);
    // Wait for the React tree and the bridge.
    await send("Runtime.evaluate", {
      expression: "new Promise((r) => { const t = setInterval(() => { if (window.piApp) { clearInterval(t); r(); } }, 100); })",
      awaitPromise: true,
    });

    const script = String.raw`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const api = window.piApp;
        const counters = { pick: 0, paste: 0 };
        api.pickWorkspace = async () => { counters.pick += 1; return null; };
        api.readClipboardImage = async () => { counters.paste += 1; return { ok: false }; };

        const fire = (target, init) => {
          const event = new KeyboardEvent("keydown", {
            bubbles: true, cancelable: true, composed: true, ...init,
          });
          target.dispatchEvent(event);
          return event;
        };

        const ctrlO = fire(document.body, { key: "o", code: "KeyO", ctrlKey: true });
        await sleep(60);

        const beforeBody = counters.paste;
        fire(document.body, { key: "v", code: "KeyV", ctrlKey: true });
        await sleep(200);

        const textarea = document.createElement("textarea");
        document.body.appendChild(textarea);
        textarea.focus();
        const beforeEditor = counters.paste;
        const editorChord = fire(textarea, { key: "v", code: "KeyV", ctrlKey: true });
        await sleep(150);
        textarea.remove();

        const shiftN = fire(document.body, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });

        return {
          ctrlO_dispatched: counters.pick,
          ctrlO_prevented: ctrlO.defaultPrevented,
          ctrlV_outside_editor: counters.paste - beforeBody,
          ctrlV_inside_editor: counters.paste - beforeEditor,
          ctrlV_editor_prevented: editorChord.defaultPrevented,
          ctrlShiftN_prevented: shiftN.defaultPrevented,
        };
      })()
    `;

    const evaluation = await send("Runtime.evaluate", {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = evaluation.result?.value;
    console.log(JSON.stringify(value));

    const ok =
      value &&
      value.ctrlO_dispatched === 1 &&
      value.ctrlO_prevented === true &&
      value.ctrlV_outside_editor === 1 &&
      value.ctrlV_inside_editor === 0 &&
      value.ctrlV_editor_prevented === false &&
      value.ctrlShiftN_prevented === false;
    console.log(ok ? "PASS: shell chords are claimed exactly once, editors keep Ctrl+V" : "FAIL");
    socket.close();
    cleanup();
    process.exit(ok ? 0 : 1);
  } finally {
    try { socket.close(); } catch {}
    cleanup();
  }
}

main().catch((error) => {
  console.error("FAIL:", error);
  process.exit(1);
});
