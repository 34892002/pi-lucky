/**
 * Build the renderer into `resources/`.
 *
 * Vite writes hashed asset names and `emptyOutDir` is off (the folder also holds the
 * Neutralino client library and the app icon, which Vite must not touch), so every build
 * would otherwise leave the previous bundle behind and `resources.neu` would grow with
 * each run. The generated output is cleared explicitly instead.
 */
import { rmSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const resourcesDir = path.join(repoRoot, "resources");

for (const generated of ["assets", "index.html"]) {
  rmSync(path.join(resourcesDir, generated), { recursive: true, force: true });
}

const result = Bun.spawnSync({
  cmd: [
    path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.exe" : "vite"),
    "build",
    "--config",
    "apps/desktop/vite.config.ts",
    ...process.argv.slice(2),
  ],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode ?? 1);
