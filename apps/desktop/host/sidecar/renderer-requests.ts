/**
 * Sidecar → renderer requests that need an answer.
 *
 * pi-gui asked the OS directly for everything host-driven: folder pickers, file
 * pickers, and the two prompts used during provider login (open a URL, then paste a
 * code). Neutralino splits that world in two — dialogs and prompts belong to the
 * webview, while the code that must *act* on the answer (reading attachment bytes,
 * adding a workspace) lives in the sidecar. So the sidecar asks the renderer.
 */
import { randomUUID } from "node:crypto";
import type { ShellCopyKey } from "../../contracts/shell-copy";
import type { PushBus } from "../transport/push-bus";

export type RendererRequest =
  | ({ readonly kind: "prompt"; readonly message: string; readonly placeholder?: string; readonly allowEmpty: boolean })
  | { readonly kind: "alert"; readonly message: string }
  | { readonly kind: "open-folder"; readonly title?: string; readonly titleKey?: ShellCopyKey }
  | {
      readonly kind: "open-files";
      readonly title?: string;
      readonly titleKey?: ShellCopyKey;
      readonly multiSelections?: boolean;
    };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export const RENDERER_REQUEST_CHANNEL = "pi-gui:renderer-request";
export const RENDERER_RESPONSE_CHANNEL = "pi-gui:renderer-response";

export class RendererRequestBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly bus: PushBus) {}

  request<T = string>(request: RendererRequest): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.bus.broadcast(RENDERER_REQUEST_CHANNEL, { id, ...request });
    });
  }

  /** Called from the `pi-gui:renderer-response` RPC the renderer posts back. */
  settle(input: unknown): void {
    if (typeof input !== "object" || input === null) {
      return;
    }
    const { id, value, error } = input as { id?: unknown; value?: unknown; error?: unknown };
    if (typeof id !== "string") {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (typeof error === "string") {
      pending.reject(new Error(error));
      return;
    }
    pending.resolve(value);
  }

  /** The renderer went away: nothing can answer, so fail every waiter. */
  rejectAll(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
