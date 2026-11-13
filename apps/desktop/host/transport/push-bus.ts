/**
 * One-way push bus: `webContents.send(channel, payload)` → WebSocket broadcast.
 *
 * Each connection carries its own view state, so pushes are projected per window
 * exactly like pi-gui's `WindowOwner.attachStatePublisher`.
 */
export interface PushConnection {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isOpen(): boolean;
}

export interface PushEnvelope {
  readonly channel: string;
  readonly payload: unknown;
}

export class PushBus {
  private readonly connections = new Map<number, PushConnection>();
  private nextId = 1;

  attach(send: (envelope: PushEnvelope) => void, isOpen: () => boolean): PushConnection {
    const id = this.nextId;
    this.nextId += 1;
    const connection: PushConnection = {
      id,
      send: (channel, payload) => send({ channel, payload }),
      isOpen,
    };
    this.connections.set(id, connection);
    return connection;
  }

  detach(connection: PushConnection): void {
    this.connections.delete(connection.id);
  }

  get size(): number {
    return this.connections.size;
  }

  all(): readonly PushConnection[] {
    return [...this.connections.values()];
  }

  broadcast(channel: string, payload: unknown): void {
    for (const connection of this.connections.values()) {
      if (!connection.isOpen()) {
        this.connections.delete(connection.id);
        continue;
      }
      connection.send(channel, payload);
    }
  }
}
