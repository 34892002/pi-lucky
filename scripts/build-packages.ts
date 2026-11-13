/**
 * Build the shared workspace packages the same way pi-gui does (tsc → dist).
 *
 * Keeping the packages as prebuilt `dist` artifacts means `@pi-gui/*` resolves
 * through package.json `exports` everywhere (Bun, tsc, vite) with no path aliases,
 * so the sidecar bundle and the renderer bundle see exactly the same modules.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesDir = path.join(repoRoot, "packages");

const order = ["session-driver", "catalogs", "extension-ui", "pi-sdk-driver"];

for (const name of order) {
  const dir = path.join(packagesDir, name);
  const has = readdirSync(packagesDir).includes(name);
  if (!has) {
    console.warn(`[build-packages] skip missing package ${name}`);
    continue;
  }
  console.log(`[build-packages] ${name}`);
  const result = Bun.spawnSync({
    cmd: [process.execPath, path.join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(dir, "tsconfig.json")],
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`[build-packages] ${name} failed with ${result.exitCode}`);
    process.exit(result.exitCode ?? 1);
  }
}
console.log("[build-packages] done");
