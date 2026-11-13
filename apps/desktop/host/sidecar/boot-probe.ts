/**
 * Boot probe: prove the ported host core runs under Bun with no Electron.
 *
 * This is the risk gate for the whole Neutralino migration — if the real
 * DesktopAppStore initializes here, every later step is plumbing.
 */
import os from "node:os";
import { DesktopAppStore } from "../application/app-store";
import { resolveUserDataDir } from "../env";

const userDataDir = resolveUserDataDir().dir;
console.log("[probe] userDataDir:", userDataDir);
console.log("[probe] runtime:", `bun ${Bun.version}`, `(${process.platform}-${process.arch})`);

const startedAt = performance.now();
const store = new DesktopAppStore({
  userDataDir,
  initialWorkspacePaths: [],
});

await store.initialize();
const state = await store.getState();

const sessionCount = state.workspaces.reduce((total, w) => total + w.sessions.length, 0);
console.log("[probe] initialize ok in", Math.round(performance.now() - startedAt), "ms");
console.log(
  "[probe] state:",
  JSON.stringify(
    {
      workspaces: state.workspaces.map((w) => ({
        name: w.name,
        path: w.path,
        threads: w.sessions.length,
      })),
      sessionCount,
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      activeView: state.activeView,
      themeMode: state.themeMode,
      runtimeWorkspaces: Object.keys(state.runtimeByWorkspace).length,
      scheduledTasks: state.scheduledTasks.length,
      revision: state.revision,
    },
    null,
    2,
  ),
);

// Exercise a real mutation + event stream so we know the store is live, not just constructed.
let pushes = 0;
const unsubscribe = store.subscribe(() => {
  pushes += 1;
});
const next = await store.addWorkspace(os.homedir());
console.log("[probe] addWorkspace ->", next.workspaces.length, "workspace(s)");
await new Promise((resolve) => setTimeout(resolve, 150));
unsubscribe();
console.log("[probe] state pushes observed:", pushes);

console.log("[probe] PASS");
process.exit(0);
