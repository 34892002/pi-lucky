import { afterAll, expect, test } from "bun:test";
import type { CustomProviderProbeInput } from "../../contracts/ipc";
import { expectCustomProviderProbeInput } from "../ipc/request-validation";
import { probeCustomProviderModels } from "./custom-provider-model-probe";

const requests: { url: URL; method: string; headers: Headers }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch(request) {
    const url = new URL(request.url);
    requests.push({ url, method: request.method, headers: request.headers });
    if (url.pathname === "/apps/anthropic/v1/models") {
      return new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith("/failure/")) {
      return Response.json({ error: "secret-test-key https://secret.invalid" }, {
        status: 401, statusText: "secret-test-key",
      });
    }
    if (url.pathname.startsWith("/timeout/")) {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.startsWith("/invalid-json/")) return new Response("secret-test-key https://secret.invalid");
    if (url.pathname.startsWith("/missing/")) return Response.json({ error: "secret-test-key" });
    if (url.pathname.startsWith("/null/")) return Response.json(null);
    if (url.pathname.startsWith("/wrong-data/")) return Response.json({ data: {} });
    if (url.pathname.startsWith("/empty/")) return Response.json({ data: [] });
    return Response.json({ data: [
      { id: "z-model", name: "Ignored", context_window: 123 },
      { id: "a-model" }, { id: "z-model" }, { id: " a-model " },
      { id: "" }, { id: "  " }, { id: 12 }, {}, null, "ignored",
    ] });
  },
});
afterAll(() => server.stop(true));

function input(prefix = ""): CustomProviderProbeInput {
  return {
    baseUrl: `http://127.0.0.1:${server.port}${prefix}/v1///`,
    apiKey: " secret-test-key ",
  };
}

test("GETs baseUrl/models with default OpenAI auth and returns only sorted unique nonempty IDs", async () => {
  expect(await probeCustomProviderModels(expectCustomProviderProbeInput(input()))).toEqual({
    ok: true, models: ["a-model", "z-model"],
  });
  const request = requests.at(-1)!;
  expect(request.url.pathname).toBe("/v1/models");
  expect(request.method).toBe("GET");
  expect(request.headers.get("authorization")).toBe("Bearer secret-test-key");
  expect(request.headers.get("x-api-key")).toBeNull();
});

test("uses Anthropic key and version headers when selected through IPC", async () => {
  expect((await probeCustomProviderModels(expectCustomProviderProbeInput({
    ...input(), api: "anthropic-messages",
  }))).ok).toBe(true);
  const request = requests.at(-1)!;
  expect(request.url.pathname).toBe("/v1/models");
  expect(request.headers.get("x-api-key")).toBe("secret-test-key");
  expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(request.headers.get("authorization")).toBeNull();
});

test("adds /v1 when discovering models from an Anthropic Messages base URL", async () => {
  const baseUrl = new URL("/gateway", input().baseUrl).href;
  expect((await probeCustomProviderModels({ ...input(), baseUrl, api: "anthropic-messages" })).ok).toBe(true);
  expect(requests.at(-1)!.url.pathname).toBe("/gateway/v1/models");
});

test("reports a missing Anthropic models route without falling back to OpenAI", async () => {
  const before = requests.length;
  const baseUrl = new URL("/apps/anthropic/", input().baseUrl).href;
  expect(await probeCustomProviderModels({ ...input(), baseUrl, api: "anthropic-messages" })).toEqual({
    ok: false, error: "Model discovery request failed (HTTP 404).",
  });
  expect(requests).toHaveLength(before + 1);
  expect(requests.at(-1)!.url.pathname).toBe("/apps/anthropic/v1/models");
  expect(requests.at(-1)!.headers.get("x-api-key")).toBe("secret-test-key");
  expect(requests.at(-1)!.headers.get("authorization")).toBeNull();
});

test("allows endpoints without keys for both API types", async () => {
  for (const api of ["openai-completions", "anthropic-messages"] as const) {
    expect((await probeCustomProviderModels({ ...input(), api, apiKey: " " })).ok).toBe(true);
    expect(requests.at(-1)!.headers.get("authorization")).toBeNull();
    expect(requests.at(-1)!.headers.get("x-api-key")).toBeNull();
  }
});

test("preserves URL query parameters while appending the models path", async () => {
  expect((await probeCustomProviderModels({ ...input(), baseUrl: `${input().baseUrl}?tenant=example` })).ok).toBe(true);
  expect(requests.at(-1)!.url.pathname).toBe("/v1/models");
  expect(requests.at(-1)!.url.searchParams.get("tenant")).toBe("example");
});

test("rejects invalid URLs before making a request", async () => {
  const before = requests.length;
  for (const baseUrl of ["", "not a URL", "file:///secret", "ftp://secret.invalid"]) {
    expect(await probeCustomProviderModels({ ...input(), baseUrl })).toEqual({
      ok: false, error: "Base URL must start with http:// or https://.",
    });
  }
  expect(requests.length).toBe(before);
});

test("IPC preserves optional API selection and rejects unknown values without echoing them", () => {
  expect(expectCustomProviderProbeInput(input()).api).toBeUndefined();
  expect(expectCustomProviderProbeInput({ ...input(), api: "openai-completions" }).api).toBe("openai-completions");
  for (const api of [null, 1, "secret-test-key", {}]) {
    expect(() => expectCustomProviderProbeInput({ ...input(), api })).toThrow(
      "input.api must be openai-completions or anthropic-messages",
    );
  }
});

test("reports an empty data array as a successful empty list", async () => {
  expect(await probeCustomProviderModels(input("/empty"))).toEqual({ ok: true, models: [] });
});

test("reports missing or invalid data arrays as safe errors", async () => {
  for (const prefix of ["/missing", "/null", "/wrong-data"]) {
    expect(await probeCustomProviderModels(input(prefix))).toEqual({
      ok: false, error: 'Model discovery response is missing a "data" array.',
    });
  }
});

test("does not forward HTTP status text, response secrets, parsing errors, or request URLs", async () => {
  expect(await probeCustomProviderModels(input("/failure"))).toEqual({
    ok: false, error: "Model discovery request failed (HTTP 401).",
  });
  for (const probeInput of [input("/invalid-json"), {
    ...input(), baseUrl: "http://secret-test-key:secret-test-key@secret.invalid/v1",
  }]) {
    const result = await probeCustomProviderModels(probeInput);
    expect(result).toEqual({
      ok: false, error: "Model discovery request failed. Check the endpoint and API key.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  }
});

test("bounds a stalled response body to 10 seconds", async () => {
  const start = Date.now();
  expect(await probeCustomProviderModels(input("/timeout"))).toEqual({
    ok: false, error: "Model discovery timed out after 10 seconds.",
  });
  expect(Date.now() - start).toBeLessThan(13_000);
}, 15_000);
