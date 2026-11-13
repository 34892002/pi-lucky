/**
 * Renderer bundle for the Neutralino webview.
 *
 * Neutralino serves `resources/` as the document root, so the build output lands
 * beside `js/neutralino.js` and the app loads `index.html` with relative URLs
 * (`base: "./"`) — the same layout works from `neu run`, a packaged binary, or a
 * plain static server.
 */
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const appRoot = import.meta.dirname;
const repoRoot = path.resolve(appRoot, "..", "..");
const resourcesDir = path.join(repoRoot, "resources");

export default defineConfig(({ mode }) => {
  const dev = mode !== "production";
  return {
    root: appRoot,
    base: "./",
    publicDir: false,
    plugins: [
      react(),
      tsconfigPaths({ projects: [path.join(appRoot, "tsconfig.paths.json")] }),
    ],
    define: {
      __PI_SIDECAR_DEV__: JSON.stringify(dev),
      // In dev the sidecar runs from source, so host changes need no rebuild.
      __PI_SIDECAR_DEV_COMMAND__: JSON.stringify("bun run apps/desktop/host/sidecar/main.ts"),
      __PI_SIDECAR_DEV_CWD__: JSON.stringify(repoRoot),
    },
    build: {
      outDir: resourcesDir,
      // `resources/` also holds the Neutralino client, icons and the sidecar binary,
      // so the app must not clear it; only Vite's own `assets/` directory is replaced.
      emptyOutDir: false,
      target: "chrome120",
      sourcemap: dev,
      rollupOptions: { input: path.join(appRoot, "index.html") },
    },
    server: { port: 5173, strictPort: true },
  };
});
