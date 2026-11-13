/**
 * Channel registry: the Neutralino-era replacement for `ipcMain.handle`.
 *
 * pi-gui's IPC layer is written as `handle(channel, decode, handler)`; keeping the
 * same shape here means ported handlers stay byte-for-byte identical while the
 * transport underneath becomes HTTP.
 */
export interface RpcErrorPayload {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
}

export type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RpcErrorPayload };

/** Mirrors Electron’s `ipcMain` listener arity: arguments arrive as a list. */
export type RpcHandler<Result = unknown> = (args: readonly unknown[]) => Result | Promise<Result>;

export class UnknownChannelError extends Error {
  constructor(readonly channel: string) {
    super(`Unknown channel: ${channel}`);
    this.name = "UnknownChannelError";
  }
}

export function serializeRpcError(error: unknown): RpcErrorPayload {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: typeof error === "string" ? error : "Unknown error" };
}

export class RpcRegistry {
  private readonly handlers = new Map<string, RpcHandler>();

  handle<Result>(channel: string, handler: RpcHandler<Result>): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Duplicate channel handler: ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  /** Replace an existing handler (used by dev reload). */
  replace<Result>(channel: string, handler: RpcHandler<Result>): void {
    this.handlers.set(channel, handler);
  }

  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  get size(): number {
    return this.handlers.size;
  }

  channels(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }

  async invoke(channel: string, args: readonly unknown[] = []): Promise<RpcResult> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      return { ok: false, error: serializeRpcError(new UnknownChannelError(channel)) };
    }
    try {
      return { ok: true, value: await handler(args) };
    } catch (error) {
      return { ok: false, error: serializeRpcError(error) };
    }
  }
}
