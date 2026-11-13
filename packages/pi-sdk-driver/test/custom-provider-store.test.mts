import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CustomProviderStore } from "../dist/custom-provider-store.js";

const endpoint = {
  providerId: "local-endpoint",
  baseUrl: "http://localhost:8080/v1",
  models: [{ id: "test-model" }],
};

async function withStore(
  run: (store: CustomProviderStore, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-provider-"));
  // Retain synthetic fixtures for failure inspection, per repository policy.
  const path = join(dir, "models.json");
  await run(new CustomProviderStore(path), path);
}

for (const providers of [[], ["saved-value"], null, false, 0, "saved-value"]) {
  await test(`rejects malformed providers ${JSON.stringify(providers)} without changing bytes`, async () => {
    await withStore(async (store, path) => {
      const original = `${JSON.stringify({ providers, futureSetting: { retained: true } }, null, 4)}\n`;
      await writeFile(path, original);
      for (const operation of [
        () => store.list(),
        () => store.set(endpoint),
        () => store.delete(endpoint.providerId),
      ]) {
        await assert.rejects(operation, /JSON object for providers/);
        assert.equal(await readFile(path, "utf8"), original);
      }
    });
  });
}

await test("missing file or providers supports saving and reopening an endpoint", async () => {
  for (const initial of [undefined, "", '{"futureSetting":{"retained":true}}']) {
    await withStore(async (store, path) => {
      if (initial !== undefined) await writeFile(path, initial);
      assert.deepEqual(await store.list(), []);
      assert.equal(await store.delete(endpoint.providerId), false);
      await store.set(endpoint);
      assert.deepEqual(await new CustomProviderStore(path).list(), [{ ...endpoint, api: "openai-completions" }]);
      if (initial) {
        const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        assert.deepEqual(saved.futureSetting, {
          retained: true,
        });
      }
      assert.equal(await store.delete(endpoint.providerId), true);
      assert.deepEqual(await store.list(), []);
    });
  }
});

await test("legacy configs default to OpenAI and retain OpenAI compat", async () => {
  await withStore(async (store, path) => {
    const models = [{ id: "vision", supportsImages: true, maxTokensField: "max_tokens" as const, thinkingFormat: "openai" as const }];
    await writeFile(path, JSON.stringify({ providers: {
      [endpoint.providerId]: { baseUrl: endpoint.baseUrl, piGuiCustomEndpoint: true, models: [{ id: "vision" }] },
    } }));
    const [legacy] = await store.list();
    assert.equal(legacy?.api ?? "openai-completions", "openai-completions");
    await store.set({ ...legacy!, models });
    const saved = JSON.parse(await readFile(path, "utf8")).providers[endpoint.providerId];
    assert.equal(saved.api, "openai-completions");
    assert.deepEqual(saved.models[0].input, ["text", "image"]);
    assert.deepEqual(saved.models[0].compat, { maxTokensField: "max_tokens", thinkingFormat: "openai" });
    assert.deepEqual((await store.list())[0]?.models, models);
  });
});

await test("Anthropic editing round trips multimodal models without OpenAI compat", async () => {
  await withStore(async (store, path) => {
    const anthropic = {
      ...endpoint,
      api: "anthropic-messages" as const,
      apiKey: "test-key",
      models: [{ id: "vision", name: "Vision", supportsImages: true, reasoning: true, contextWindow: 200000, maxTokens: 8192 }],
    };
    await store.set({ ...anthropic, models: anthropic.models.map((model) => ({
      ...model, maxTokensField: "max_tokens", thinkingFormat: "openai",
    })) });
    let saved = JSON.parse(await readFile(path, "utf8")).providers[endpoint.providerId];
    assert.equal(saved.api, "anthropic-messages");
    assert.equal(saved.models[0].compat, undefined);
    assert.deepEqual(saved.models[0].input, ["text", "image"]);
    const [reopened] = await new CustomProviderStore(path).list();
    assert.deepEqual(reopened, anthropic);
    await store.set({ ...reopened!, baseUrl: "https://example.com" });
    saved = JSON.parse(await readFile(path, "utf8")).providers[endpoint.providerId];
    assert.equal(saved.api, "anthropic-messages");
    assert.equal(saved.models[0].compat, undefined);
    assert.deepEqual((await store.list())[0], { ...anthropic, baseUrl: "https://example.com" });
  });
});

await test("invalid provider protocols cannot change saved data", async () => {
  await withStore(async (store, path) => {
    await store.set(endpoint);
    const before = await readFile(path, "utf8");
    for (const api of [null, "", "openai-responses", 1, {}]) {
      await assert.rejects(() => store.set({ ...endpoint, api } as unknown as Parameters<CustomProviderStore["set"]>[0]), /Provider api/);
      assert.equal(await readFile(path, "utf8"), before);
    }
  });
});

await test("set and delete preserve unrelated upstream fields and providers", async () => {
  await withStore(async (store, path) => {
    const original = {
      futureSetting: { retained: true },
      providers: {
        upstream: { api: "future-api", customField: ["preserved"] },
      },
    };
    await writeFile(path, JSON.stringify(original));
    await store.set(endpoint);
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      futureSetting: unknown;
      providers: Record<string, unknown>;
    };
    assert.deepEqual(saved.futureSetting, original.futureSetting);
    assert.deepEqual(saved.providers.upstream, original.providers.upstream);
    assert.equal(await store.delete(endpoint.providerId), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
  });
});

await test("malformed existing target configs are never overwritten", async () => {
  for (const config of [null, false, 0, "saved-value", [], {}]) {
    await withStore(async (store, path) => {
      const original = JSON.stringify({ providers: { [endpoint.providerId]: config } });
      await writeFile(path, original);
      await assert.rejects(() => store.set(endpoint), /not managed by pi-gui/);
      assert.equal(await store.delete(endpoint.providerId), false);
      assert.equal(await readFile(path, "utf8"), original);
    });
  }
});

await test("the queue recovers once malformed saved data is repaired externally", async () => {
  await withStore(async (store, path) => {
    await writeFile(path, '{"providers":[]}');
    await assert.rejects(() => store.set(endpoint), /JSON object for providers/);
    await writeFile(path, '{"providers":{}}');
    await store.set(endpoint);
    assert.deepEqual(await store.list(), [{ ...endpoint, api: "openai-completions" }]);
  });
});
