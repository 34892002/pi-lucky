import { afterAll, expect, test } from "bun:test";
import type { CustomProviderConfig } from "../../contracts/ipc";
import { expectCustomProviderConfig } from "../ipc/request-validation";
import { testCustomProviderModel } from "./custom-provider-model-test";

const requests: { path: string; headers: Headers; body: Record<string, unknown> }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, unknown>;
    requests.push({ path, headers: request.headers, body });
    if (path.startsWith("/failure/")) {
      return Response.json({ error: { message: "secret-test-key https://secret.invalid" } }, { status: 401 });
    }
    if (path.startsWith("/timeout/")) {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (path.endsWith("/messages")) {
      const events = [
        ["message_start", { type: "message_start", message: { id: "test", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const content = path.startsWith("/empty/") ? "" : "OK";
    return new Response([
      { id: "test", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
      { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
afterAll(() => server.stop(true));

function config(prefix = ""): CustomProviderConfig {
  return {
    providerId: "unsaved-provider",
    baseUrl: `http://127.0.0.1:${server.port}${prefix}/v1`,
    apiKey: "secret-test-key",
    models: [{ id: "unsaved-model", maxTokens: 16, reasoning: true, supportsImages: true, maxTokensField: "max_tokens", thinkingFormat: "qwen" }],
  };
}

test("uses the unsaved OpenAI model, key, endpoint and compatibility settings through the SDK", async () => {
  expect(await testCustomProviderModel(expectCustomProviderConfig(config()))).toEqual({ ok: true });
  const request = requests.at(-1)!;
  expect(request.path).toBe("/v1/chat/completions");
  expect(request.headers.get("authorization")).toBe("Bearer secret-test-key");
  expect(request.body.model).toBe("unsaved-model");
  expect(request.body.max_tokens).toBe(16);
  expect(request.body.max_completion_tokens).toBeUndefined();
  expect(request.body.enable_thinking).toBe(false);
  expect(JSON.stringify(request.body.messages)).toContain("Reply with OK.");
});

test("uses the Anthropic SDK adapter with the supplied endpoint and key", async () => {
  const input = config();
  expect(await testCustomProviderModel({
    ...input,
    baseUrl: input.baseUrl.replace(/\/v1$/, ""),
    api: "anthropic-messages",
  })).toEqual({ ok: true });
  const request = requests.at(-1)!;
  expect(request.path).toBe("/v1/messages");
  expect(request.headers.get("x-api-key")).toBe("secret-test-key");
  expect(request.body.model).toBe("unsaved-model");
  expect(request.body.max_tokens).toBe(16);
});

test("requires exactly one model and an HTTP endpoint before making a request", async () => {
  const before = requests.length;
  for (const models of [[], [...config().models, ...config().models]]) {
    expect((await testCustomProviderModel({ ...config(), models })).ok).toBe(false);
  }
  expect((await testCustomProviderModel({ ...config(), baseUrl: "file:///secret" })).ok).toBe(false);
  expect(requests.length).toBe(before);
  expect(() => expectCustomProviderConfig({ ...config(), models: [{ id: "x", maxTokensField: "secret-test-key" }] })).toThrow();
});

test("returns safe errors for provider failures without forwarding response secrets", async () => {
  const result = await testCustomProviderModel(config("/failure"));
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret-test-key");
  expect(JSON.stringify(result)).not.toContain("secret.invalid");
});

test("does not report an empty completion as available", async () => {
  expect(await testCustomProviderModel(config("/empty"))).toEqual({
    ok: false, error: "Model availability test returned no text.",
  });
});

test("bounds a stalled SDK stream to 30 seconds", async () => {
  const start = Date.now();
  expect(await testCustomProviderModel(config("/timeout"))).toEqual({
    ok: false, error: "Model availability test timed out after 30 seconds.",
  });
  expect(Date.now() - start).toBeLessThan(33_000);
}, 35_000);
