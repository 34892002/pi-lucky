/**
 * Compiles the sidecar to a single Windows executable.
 *
 * This is the replacement for Electron's `out/main` bundle: one binary that carries
 * the Bun runtime, the session driver and every dependency, so the shipped app has no
 * `node_modules` at all. Runtime files loaded from disk (node-pty and Photon WASM)
 * are copied next to the binary.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const entry = path.join(repoRoot, "apps/desktop/host/sidecar/main.ts");
// Outside `resources/`: Neutralino packs that directory into `resources.neu`, and the
// sidecar must stay a real file on disk next to the app binary.
const outDir = path.join(repoRoot, "build", "binaries");
const outFile = path.join(outDir, "pi-lucky-sidecar.exe");
const photonWasm = "photon_rs_bg.wasm";
const photonSource = path.join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", photonWasm);
if (!existsSync(photonSource)) {
  throw new Error(`[build-sidecar] missing ${path.relative(repoRoot, photonSource)}; run bun install`);
}

const target = process.env.PI_LUCKY_TARGET ?? "bun-windows-x64";
const production = process.env.PI_LUCKY_DEV !== "1";

// The shipped node-pty copy needs the same Bun input fix the dev tree has.
const patch = Bun.spawnSync({
  cmd: [process.execPath, "run", path.join(repoRoot, "scripts", "patch-node-pty.ts")],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
if (patch.exitCode !== 0) {
  console.error("[build-sidecar] node-pty patch failed");
  process.exit(1);
}

rmSync(outFile, { force: true });
mkdirSync(outDir, { recursive: true });
// Stale artifacts from earlier builds would otherwise be shipped next to the binary.
for (const stale of [`${outFile}.map`, path.join(outDir, "main.js.map")]) {
  rmSync(stale, { force: true });
}

console.log(`[build-sidecar] ${path.relative(repoRoot, entry)} -> ${path.relative(repoRoot, outFile)}`);

const result = Bun.spawnSync({
  cmd: [
    process.execPath,
    "build",
    entry,
    "--compile",
    "--target",
    target,
    "--outfile",
    outFile,
    ...(production ? ["--minify"] : []),
    // A shipped app must not carry megabytes of map data; dev keeps it for stack traces.
    ...(production ? [] : ["--sourcemap=inline"]),
    // node-pty cannot be bundled: it loads its .node binding from its own directory.
    "--external",
    "node-pty",
  ],
  cwd: repoRoot,
  env: { ...process.env, NODE_ENV: production ? "production" : "development" },
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  console.error("[build-sidecar] compile failed");
  process.exit(1);
}

// Pi's Photon loader falls back to a file beside process.execPath when the
// bundled JS loader cannot read the WASM from its original package directory.
cpSync(photonSource, path.join(outDir, photonWasm));
console.log(`[build-sidecar] Photon WASM -> ${path.relative(repoRoot, path.join(outDir, photonWasm))}`);

/**
 * node-pty ships beside the binary rather than inside it: its loader resolves
 * `prebuilds/<platform>-<arch>/*.node` and, on Windows, `conpty.node` +
 * `winpty-agent.exe`/`winpty.dll` relative to the package directory, which a
 * compiled executable does not have.
 */
const ptySource = path.join(repoRoot, "node_modules", "node-pty");
const ptyDestination = path.join(outDir, "node-pty");
if (existsSync(ptySource)) {
  rmSync(ptyDestination, { recursive: true, force: true });
  mkdirSync(ptyDestination, { recursive: true });
  for (const entry of ["lib", "package.json"]) {
    const from = path.join(ptySource, entry);
    if (existsSync(from)) {
      cpSync(from, path.join(ptyDestination, entry), { recursive: true });
    }
  }
  const prebuilds = path.join(ptySource, "prebuilds", "win32-x64");
  if (existsSync(prebuilds)) {
    // The prebuilds directory ships Windows debug symbols (~24 MB) that a release build
    // never loads; everything else is required at runtime.
    cpSync(prebuilds, path.join(ptyDestination, "prebuilds", "win32-x64"), {
      recursive: true,
      filter: (source) => !source.endsWith(".pdb"),
    });
  } else {
    console.warn("[build-sidecar] node-pty prebuilds missing: the terminal will not start");
  }
  console.log(`[build-sidecar] node-pty -> ${path.relative(repoRoot, ptyDestination)}`);
}

const size = statSync(outFile).size;
console.log(`[build-sidecar] ${(size / (1024 * 1024)).toFixed(1)} MB`);
