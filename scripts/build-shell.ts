/**
 * Package the Neutralino shell.
 *
 * `neu build` turns `resources/` into `resources.neu` and drops one binary per platform
 * under `dist/<binaryName>/`. The sidecar is deliberately kept out of `resources/`: it
 * is a real executable and has to sit next to the app binary, where `${NL_PATH}/binaries`
 * points at runtime.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const sidecarDir = path.join(repoRoot, "build", "binaries");
const sidecarBinary = path.join(sidecarDir, "pi-lucky-sidecar.exe");

if (!existsSync(sidecarBinary)) {
  console.error("[build-shell] missing sidecar build; run `bun run build:sidecar` first");
  process.exit(1);
}

const config = (await Bun.file(path.join(repoRoot, "neutralino.config.json")).json()) as {
  cli?: { binaryName?: string };
};
const binaryName = config.cli?.binaryName ?? "pi-lucky";
const distDir = path.join(repoRoot, "dist", binaryName);

const neuBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "neu.exe" : "neu");
const result = Bun.spawnSync({
  cmd: [neuBin, "build", "--release"],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) {
  console.error(
    "[build-shell] neu build failed; a running copy of the app locks its binary, so close it first",
  );
  process.exit(1);
}

if (!existsSync(distDir)) {
  console.error(`[build-shell] neu build did not produce ${path.relative(repoRoot, distDir)}`);
  process.exit(1);
}

// Ship the sidecar with its runtime assets (node-pty and Photon WASM) beside the app binary.
const target = path.join(distDir, "binaries");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(sidecarDir, target, { recursive: true });

/** Neutralino's platform suffix, e.g. `win_x64` or `mac_arm64`. */
function hostPlatform(): string {
  const os = { win32: "win", darwin: "mac" }[process.platform] ?? "linux";
  const arch = { x64: "x64", arm64: "arm64", arm: "armhf" }[process.arch] ?? process.arch;
  return `${os}_${arch}`;
}

// `neu build --release` emits one binary per platform. Only the host platform can run
// here and each unused binary is a few MB of noise in the shipped folder, so the others
// are dropped unless PI_LUCKY_ALL_PLATFORMS is set (for cross-platform releases).
const keepBinary = `${binaryName}-${hostPlatform()}`;
if (!process.env.PI_LUCKY_ALL_PLATFORMS) {
  for (const entry of readdirSync(distDir)) {
    // The Windows binary carries an .exe suffix, so match on the prefix.
    if (entry.startsWith(`${binaryName}-`) && !entry.startsWith(keepBinary)) {
      rmSync(path.join(distDir, entry), { force: true });
    }
  }
  if (!readdirSync(distDir).some((entry) => entry.startsWith(keepBinary))) {
    console.warn(`[build-shell] neu build did not produce ${keepBinary}`);
  }
}

const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Recursive byte count, so the listing shows where the size actually goes. */
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : statSync(full).size;
  }
  return total;
}

const entries = readdirSync(distDir, { withFileTypes: true })
  .map((entry) => {
    const full = path.join(distDir, entry.name);
    const size = entry.isDirectory()
      ? `  ${formatSize(directorySize(full))}`
      : ` ${formatSize(statSync(full).size)}`;
    return `  ${entry.name.padEnd(26)}${size}`;
  })
  .join("\n");
console.log(
  `[build-shell] ${path.relative(repoRoot, distDir)} (${formatSize(directorySize(distDir))} total):\n${entries}`,
);
console.log("[build-shell] ship this folder as-is: the binary loads resources.neu and binaries/ from its own directory");
