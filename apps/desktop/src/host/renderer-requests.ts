/**
 * Answers the sidecar's requests for native UI.
 *
 * The sidecar drives everything that touches the session store, but dialogs and
 * prompts are webview-only in Neutralino. Each request carries an id; the answer is
 * posted back over the same RPC channel the rest of the app uses.
 */
import type { ShellCopyKey } from "../../contracts/shell-copy";
import { neutralino } from "./neutralino";
import { shellCopy } from "./shell-locale";
import type { HostTransport } from "./transport";

const REQUEST_CHANNEL = "pi-gui:renderer-request";
const RESPONSE_CHANNEL = "pi-gui:renderer-response";
const ALWAYS_ON_TOP_DURING_PROMPT = true;

type SidecarRequest =
  | { id: string; kind: "prompt"; message: string; placeholder?: string; allowEmpty: boolean }
  | { id: string; kind: "alert"; message: string }
  | { id: string; kind: "open-folder"; title?: string; titleKey?: ShellCopyKey }
  | {
      id: string;
      kind: "open-files";
      title?: string;
      titleKey?: ShellCopyKey;
      multiSelections?: boolean;
    };

export function handleSidecarRequests(transport: HostTransport): () => void {
  return transport.subscribe(REQUEST_CHANNEL, (payload) => {
    const request = payload as SidecarRequest | null;
    if (!request?.id) {
      return;
    }
    void respond(transport, request).catch((error: unknown) => {
      void transport
        .invoke(RESPONSE_CHANNEL, [
          { id: request.id, error: error instanceof Error ? error.message : String(error) },
        ])
        .catch(() => undefined);
    });
  });
}

async function respond(transport: HostTransport, request: SidecarRequest): Promise<void> {
  const api = neutralino();
  let value: unknown;

  switch (request.kind) {
    case "prompt": {
      // The app window is borderless, so a native prompt can be hidden behind it.
      if (ALWAYS_ON_TOP_DURING_PROMPT) {
        await api.window.setAlwaysOnTop(true).catch(() => undefined);
      }
      try {
        value = window.prompt(request.message, request.placeholder ?? "") ?? "";
      } finally {
        if (ALWAYS_ON_TOP_DURING_PROMPT) {
          await api.window.setAlwaysOnTop(false).catch(() => undefined);
        }
      }
      break;
    }
    case "alert": {
      await api.window.setAlwaysOnTop(true).catch(() => undefined);
      try {
        window.alert(request.message);
      } finally {
        await api.window.setAlwaysOnTop(false).catch(() => undefined);
      }
      value = "";
      break;
    }
    case "open-folder": {
      value = await api.os.showFolderDialog(request.title ?? shellCopy(request.titleKey ?? "shell.openFolder"));
      break;
    }
    case "open-files": {
      value = await api.os.showOpenDialog(request.title ?? shellCopy(request.titleKey ?? "shell.openFiles"), {
        multiSelections: request.multiSelections ?? false,
      });
      break;
    }
    default:
      value = "";
  }

  await transport.invoke(RESPONSE_CHANNEL, [{ id: request.id, value }]);
}
