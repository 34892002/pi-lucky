/**
 * Renderer-side transport to the Bun sidecar.
 *
 * Replaces Electron's `ipcRenderer`: unary calls become HTTP POSTs (one channel per
 * URL), pushes arrive on a single WebSocket. Reconnects are transparent so a
 * sidecar restart (dev reload) does not strand the UI.
 */
export interface SidecarEndpoint {
  readonly origin: string;
  readonly token: string;
}

export type PushListener = (payload: unknown) => void;

export class HostTransport {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<PushListener>>();
  private readonly pending = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  private disposed = false;

  constructor(readonly endpoint: SidecarEndpoint) {}

  get origin(): string {
    return this.endpoint.origin;
  }

  /** Attach the push socket. Resolves once the first connection handshake lands. */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error("transport disposed");
    }
    return new Promise<void>((resolve, reject) => {
      const url = `${this.endpoint.origin.replace(/^http/, "ws")}/events?token=${encodeURIComponent(
        this.endpoint.token,
      )}`;
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        resolve();
      });
      socket.addEventListener("error", () => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error(`cannot reach sidecar at ${this.endpoint.origin}`));
        }
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        let frame: { channel?: unknown; payload?: unknown };
        try {
          frame = JSON.parse(event.data) as { channel?: unknown; payload?: unknown };
        } catch {
          return;
        }
        if (typeof frame.channel !== "string") {
          return;
        }
        const channelListeners = this.listeners.get(frame.channel);
        if (!channelListeners) {
          return;
        }
        for (const listener of channelListeners) {
          try {
            listener(frame.payload);
          } catch (error) {
            console.error(`[transport] listener for ${frame.channel} failed`, error);
          }
        }
      });
      socket.addEventListener("close", () => {
        this.socket = null;
        for (const waiter of this.pending) {
          waiter.resolve();
        }
        this.pending.clear();
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) {
      return;
    }
    const delay = Math.min(5000, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay) as unknown as number;
  }

  async invoke(channel: string, args: readonly unknown[] = []): Promise<unknown> {
    // JSON turns undefined array entries into null; omit absent optional arguments.
    let argumentCount = args.length;
    while (argumentCount > 0 && args[argumentCount - 1] === undefined) {
      argumentCount -= 1;
    }
    const response = await fetch(`${this.endpoint.origin}/rpc/${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.endpoint.token}`,
      },
      body: JSON.stringify({ args: args.slice(0, argumentCount) }),
    });
    if (response.status === 401) {
      throw new Error("sidecar rejected the session token");
    }
    const body = (await response.json()) as
      | { ok: true; value: unknown }
      | { ok: false; error: { message: string; stack?: string } };
    if (!body.ok) {
      const error = new Error(body.error.message);
      if (body.error.stack) {
        error.stack = body.error.stack;
      }
      throw error;
    }
    return body.value;
  }

  subscribe(channel: string, listener: PushListener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** Resolves on the next push for `channel` (used for request/response handshakes). */
  once(channel: string): Promise<unknown> {
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(channel, (payload) => {
        unsubscribe();
        resolve(payload);
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = null;
  }
}
