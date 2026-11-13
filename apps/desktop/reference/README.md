# Reference copies from pi-gui

These two files are kept for reference only and are **not** compiled or bundled.

- `preload.ts` — pi-gui's Electron preload. It is the authority on which channel each
  `piApp.*` method hits, and `scripts/gen-bridge-map.ts` parses it to regenerate
  `src/host/generated/bridge-map.ts`. pi-lucky's own bridge lives in
  `src/host/bridge.ts` and speaks the local HTTP + WebSocket transport instead of
  `ipcRenderer`.
- `main.ts` — pi-gui's Electron main process. Its behaviour is now split between
  `host/sidecar/main.ts` (the Bun backend) and `src/host/*` (the window shell).

Both are MIT-licensed pi-gui source.
