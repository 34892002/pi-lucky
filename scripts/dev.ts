/**
 * Dev loop: rebuild the renderer on change and run the shell against the source tree.
 *
 * Neutralino serves `resources/` from disk in dev (`neu run` implies `--load-dir-res`),
 * so a Vite rebuild plus a window reload is enough — no dev server needed, and the
 * renderer keeps the real `NL_*` globals the shell depends on. The sidecar runs from
 * TypeScript source under Bun, so host changes only need a window reload too.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const neuBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "neu.exe" : "neu");
const rendererConfig = path.join(repoRoot, "apps/desktop/vite.config.ts");

function run(command: string[], label: string, options: { cwd?: string } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  child.exited.then((code) => {
    if (code !== 0) {
      console.error(`[dev] ${label} exited with ${code}`);
    }
  });
  return child;
}

function runToCompletion(command: string[], label: string) {
  const result = Bun.spawnSync({ cmd: command, cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`[dev] ${label} failed`);
    process.exit(1);
  }
}

if (!existsSync(path.join(repoRoot, "resources", "js", "neutralino.js"))) {
  console.log("[dev] fetching the Neutralino client library");
  runToCompletion([neuBin, "update"], "neu update");
}

console.log("[dev] building workspace packages");
runToCompletion([process.execPath, path.join(repoRoot, "scripts", "build-packages.ts")], "build:packages");

console.log("[dev] watching the renderer");
const renderer = run(
  [process.execPath, "x", "vite", "build", "--watch", "--mode", "development", "--config", rendererConfig],
  "vite",
);

console.log("[dev] starting the shell (reload the window to pick up changes)");
const shell = run([neuBin, "run", "--", "--window-enable-inspector"], "neu run");

// Either side exiting ends the session; `neu run` is the one the user closes.
shell.exited.then(() => {
  renderer.kill();
  process.exit(0);
});
