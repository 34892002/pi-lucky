/**
 * Patch node-pty's Windows input path for Bun.
 *
 * node-pty delivers ConPTY input by wrapping the console input handle in a
 * `new net.Socket({ fd, writable: true })`. Bun creates that socket already closed on
 * Windows, so every keystroke is dropped with `ERR_SOCKET_CLOSED` — the terminal spawns,
 * prints its banner and then ignores all input. Writing to the very same handle with
 * `fs.writeSync` works, so the socket is replaced by a tiny writer shim.
 *
 * The patch is idempotent and only touches the Windows code path; it runs from
 * `postinstall` (so dev runs against source) and from `build:sidecar` (so the shipped
 * copy of node-pty is patched too).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = "_inSocketFD";
const repoRoot = path.resolve(import.meta.dir, "..");

if (process.platform !== "win32") {
  console.log("[patch-node-pty] skipped: Windows-only workaround");
  process.exit(0);
}

function resolveCandidates(): string[] {
  const direct = path.join(repoRoot, "node_modules", "node-pty");
  const candidates = new Set<string>();
  if (existsSync(path.join(direct, "lib", "windowsPtyAgent.js"))) {
    candidates.add(direct);
  }
  const bunStore = path.join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore)) {
      if (!entry.startsWith("node-pty@")) {
        continue;
      }
      const nested = path.join(bunStore, entry, "node_modules", "node-pty");
      if (existsSync(path.join(nested, "lib", "windowsPtyAgent.js"))) {
        candidates.add(nested);
      }
    }
  }
  return [...candidates];
}

const original = [
  "        var inSocketFD = fs.openSync(term.conin, 'w');",
  "        this._inSocket = new net_1.Socket({",
  "            fd: inSocketFD,",
  "            readable: false,",
  "            writable: true",
  "        });",
  "        this._inSocket.setEncoding('utf8');",
].join("\n");

const patched = [
  "        var inSocketFD = fs.openSync(term.conin, 'w');",
  "        // Bun cannot write to an fd-backed net.Socket, so write to the console input",
  "        // handle directly. Everything else node-pty expects from the socket is unused",
  "        // on this path except `destroy()` (and a `readable = false` flag on kill).",
  "        this._inSocketFD = inSocketFD;",
  "        this._inSocket = {",
  "            write: function (data) {",
  "                try {",
  "                    fs.writeSync(inSocketFD, data);",
  "                } catch (e) {",
  "                    console.error('[node-pty] write failed', e);",
  "                }",
  "            },",
  "            destroy: function () {",
  "                try {",
  "                    fs.closeSync(inSocketFD);",
  "                } catch (e) { }",
  "            },",
  "            readable: true,",
  "            writable: true",
  "        };",
].join("\n");

const candidates = resolveCandidates();
if (candidates.length === 0) {
  console.warn("[patch-node-pty] node-pty not installed yet");
  process.exit(0);
}

for (const dir of candidates) {
  const file = path.join(dir, "lib", "windowsPtyAgent.js");
  const source = readFileSync(file, "utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (source.includes(MARKER)) {
    console.log(`[patch-node-pty] already patched ${path.relative(repoRoot, file)}`);
    continue;
  }
  const target = original.split("\n").join(eol);
  if (!source.includes(target)) {
    throw new Error(`[patch-node-pty] unexpected node-pty layout in ${file}`);
  }
  writeFileSync(file, source.replace(target, patched.split("\n").join(eol)));
  console.log(`[patch-node-pty] patched ${path.relative(repoRoot, file)}`);
}
