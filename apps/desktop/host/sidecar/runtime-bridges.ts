/** Store-backed runtime bridges for the two builtin extensions pi-gui ships. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppStore } from "../application/app-store";
import {
  createOrchestrationRuntimeExtension,
  type OrchestrationRuntimeBridge,
} from "../orchestration/orchestration-runtime";
import {
  createScheduledTaskRuntimeExtension,
  type ScheduledTaskRuntimeBridge,
} from "../scheduled-tasks/scheduled-task-runtime";

export { createOrchestrationRuntimeExtension, createScheduledTaskRuntimeExtension };

/** Resolve the orchestration session a builtin-extension tool call came from. */
export function sessionRefFromExtensionContext(
  store: DesktopAppStore,
  ctx: ExtensionContext,
): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
  const sessionRef = store.findSessionRefByCwdAndSessionId(cwd, sessionId);
  if (!sessionRef) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return sessionRef;
}

export function createStoreBackedScheduledTaskRuntimeBridge(
  getStore: () => DesktopAppStore,
): ScheduledTaskRuntimeBridge {
  return {
    createScheduledTask: async (ctx, input) => {
      const store = getStore();
      await store.initialize();
      return store.createScheduledTaskToolResult(sessionRefFromExtensionContext(store, ctx), input);
    },
    listScheduledTasks: async () => {
      const store = getStore();
      await store.initialize();
      return store.listScheduledTasksToolResult();
    },
    updateScheduledTask: async (_ctx, input) => {
      const store = getStore();
      await store.initialize();
      return store.updateScheduledTaskToolResult(input);
    },
  };
}

export function createStoreBackedOrchestrationRuntimeBridge(
  getStore: () => DesktopAppStore,
): OrchestrationRuntimeBridge {
  return {
    archiveChildThreads: async (ctx, threadIds) => {
      const store = getStore();
      await store.initialize();
      return store.archiveChildThreadsToolResult(
        sessionRefFromExtensionContext(store, ctx),
        threadIds,
      );
    },
    createChildThread: async (ctx, input) => {
      const store = getStore();
      await store.initialize();
      return store.createChildThreadToolResult(sessionRefFromExtensionContext(store, ctx), input);
    },
    listThreads: async (ctx, input) => {
      const store = getStore();
      await store.initialize();
      return store.listThreadsToolResult(
        sessionRefFromExtensionContext(store, ctx),
        input.workspace,
      );
    },
    readThread: async (ctx, threadId) => {
      const store = getStore();
      await store.initialize();
      return store.readThreadToolResult(sessionRefFromExtensionContext(store, ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      const store = getStore();
      await store.initialize();
      return store.sendMessageToThreadToolResult(
        sessionRefFromExtensionContext(store, ctx),
        input,
      );
    },
  };
}
