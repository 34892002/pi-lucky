/**
 * Local loopback server: the sidecar's whole surface to the Neutralino webview.
 *
 * Mapping from Electron:
 *   ipcRenderer.invoke(channel, ...args) → POST /rpc/<channel> {"args":[...]}
 *   webContents.send(channel, payload)   → WS /events frame {channel, payload}
 *
 * Bound to 127.0.0.1 only and guarded by a per-launch bearer token handed to the
 * renderer on the sidecar's stdout: the webview is served from the Neutralino
 * origin, so every request is cross-origin and must be proven.
 */
import { TOOL_IMAGE_ROUTE, TOOL_IMAGE_SCHEME, toolImagePath } from "../../contracts/tool-output-images";
import type { PushBus } from "./push-bus";
import type { RpcRegistry } from "./rpc-registry";

export interface RouteRequest {
  readonly request: Request;
  readonly url: URL;
}

export type RouteHandler = (request: RouteRequest) => Promise<Response> | Response | undefined;

export interface SidecarServerOptions {
  readonly rpc: RpcRegistry;
  readonly bus: PushBus;
  readonly token: string;
  readonly version: string;
  readonly toolImageResponse?: (src: string) => Response;
  /** Extra HTTP routes (extension frames, workspace assets). */
  readonly routes?: readonly RouteHandler[];
  readonly onError?: (error: unknown) => void;
}

export interface SidecarServer {
  readonly origin: string;
  readonly port: number;
  stop(): void;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-pi-client",
  "access-control-max-age": "600",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function bearerFrom(request: Request, url: URL): string | null {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return url.searchParams.get("token");
}

export function startSidecarServer(options: SidecarServerOptions): SidecarServer {
  const { rpc, bus, token } = options;
  const isAuthorized = (request: Request, url: URL) => bearerFrom(request, url) === token;
  // Bun's socket handlers only receive the socket, and its data is fixed at upgrade
  // time, so the push identity lives in a side table keyed by the socket.
  const pushIds = new WeakMap<object, number>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/health") {
        return json({ ok: true, version: options.version, channels: rpc.size });
      }

      if (url.pathname === "/events") {
        if (!isAuthorized(request, url)) {
          return json({ ok: false, error: { message: "Unauthorized" } }, 401);
        }
        const upgraded = server.upgrade(request);
        if (!upgraded) {
          return json({ ok: false, error: { message: "Upgrade failed" } }, 400);
        }
        return undefined;
      }

      if (url.pathname.startsWith("/rpc/")) {
        if (!isAuthorized(request, url)) {
          return json({ ok: false, error: { message: "Unauthorized" } }, 401);
        }
        if (request.method !== "POST") {
          return json({ ok: false, error: { message: "RPC requires POST" } }, 405);
        }
        const channel = decodeURIComponent(url.pathname.slice("/rpc/".length));
        // The body is always `{ args }` so a single array argument (a batch of
        // attachments, say) cannot be mistaken for an argument list.
        let args: unknown[] = [];
        const raw = await request.text();
        if (raw.length > 0) {
          try {
            const parsed = JSON.parse(raw) as { args?: unknown };
            args = Array.isArray(parsed.args) ? parsed.args : [];
          } catch {
            return json({ ok: false, error: { message: "Malformed RPC body" } }, 400);
          }
        }
        return json(await rpc.invoke(channel, args));
      }

      if (options.toolImageResponse && url.pathname.startsWith(`${TOOL_IMAGE_ROUTE}/`)) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return json({ ok: false, error: { message: "Unauthorized" } }, 401);
        }
        if (request.method !== "GET") {
          return json({ ok: false, error: { message: "Image requests require GET" } }, 405);
        }
        const src = `${TOOL_IMAGE_SCHEME}://image${url.pathname.slice(TOOL_IMAGE_ROUTE.length)}`;
        if (!toolImagePath(src)) {
          return json({ ok: false, error: { message: "Invalid tool image reference" } }, 400);
        }
        const response = options.toolImageResponse(src);
        response.headers.set("cache-control", "no-store");
        response.headers.set("x-content-type-options", "nosniff");
        for (const [key, value] of Object.entries(CORS_HEADERS)) {
          response.headers.set(key, value);
        }
        return response;
      }

      for (const route of options.routes ?? []) {
        const response = await route({ request, url });
        if (response) {
          for (const [key, value] of Object.entries(CORS_HEADERS)) {
            if (!response.headers.has(key)) {
              response.headers.set(key, value);
            }
          }
          return response;
        }
      }

      return json({ ok: false, error: { message: `Not found: ${url.pathname}` } }, 404);
    },
    websocket: {
      open(socket) {
        const connection = bus.attach(
          (envelope) => {
            try {
              socket.send(JSON.stringify(envelope));
            } catch (error) {
              options.onError?.(error);
            }
          },
          () => socket.readyState === 1,
        );
        pushIds.set(socket, connection.id);
        socket.send(
          JSON.stringify({
            channel: "pi-gui:sidecar-ready",
            payload: { channels: rpc.size, version: options.version },
          }),
        );
      },
      message() {
        // Renderer → sidecar traffic uses HTTP RPC; the socket stays push-only.
      },
      close(socket) {
        const id = pushIds.get(socket);
        pushIds.delete(socket);
        if (id === undefined) {
          return;
        }
        const connection = bus.all().find((candidate) => candidate.id === id);
        if (connection) {
          bus.detach(connection);
        }
      },
    },
  });

  const port = server.port ?? 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stop: () => server.stop(true),
  };
}
