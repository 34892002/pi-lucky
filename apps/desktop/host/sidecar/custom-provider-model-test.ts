import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import {
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isValidHttpBaseUrl,
} from "@pi-gui/pi-sdk-driver/custom-provider-types";
import type {
  CustomProviderConfig,
  CustomProviderModelTestResult,
} from "../../contracts/ipc";

import { providerFetch } from "./provider-fetch";

const TEST_TIMEOUT_MS = 30_000;

export async function testCustomProviderModel(
  config: CustomProviderConfig,
): Promise<CustomProviderModelTestResult> {
  const input = config.models[0];
  if (config.models.length !== 1 || !input) {
    return { ok: false, error: "Exactly one model is required for an availability test." };
  }
  if (!isValidHttpBaseUrl(config.baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://." };
  }

  const api = config.api ?? "openai-completions";
  const model: Model<typeof api> = {
    id: input.id,
    name: input.name ?? input.id,
    provider: config.providerId,
    api,
    baseUrl: config.baseUrl.trim(),
    reasoning: input.reasoning ?? false,
    input: input.supportsImages ? ["text", "image"] : ["text"],
    contextWindow: input.contextWindow ?? 128_000,
    maxTokens: input.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(api === "openai-completions"
      ? {
          compat: {
            ...(input.maxTokensField === undefined ? {} : { maxTokensField: input.maxTokensField }),
            ...(input.thinkingFormat === undefined ? {} : { thinkingFormat: input.thinkingFormat }),
          },
        }
      : {}),
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number | undefined;
  let connectionError: "certificate" | "connection" | undefined;
  const fetchForTest: typeof globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      return await providerFetch(input, init);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      connectionError = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? "certificate" : "connection";
      throw error;
    }
  }, { preconnect: globalThis.fetch.preconnect });
  // Never forward SDK/provider errors: even their messages can echo credentials or URLs.
  const failure = (): CustomProviderModelTestResult => ({
    ok: false,
    error: connectionError === "certificate"
      ? "TLS certificate verification failed. Check the system certificate trust or proxy certificate."
      : connectionError === "connection"
      ? "Could not connect to the model endpoint. Check the network or proxy and try again."
      : status !== undefined && status >= 400
      ? `Model availability request failed (HTTP ${status}).`
      : "Model availability request failed. Check the endpoint, API key, model, and compatibility settings.",
  });
  try {
    const timeout = new Promise<CustomProviderModelTestResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, error: "Model availability test timed out after 30 seconds." });
        controller.abort();
      }, TEST_TIMEOUT_MS);
    });
    const request = async (): Promise<CustomProviderModelTestResult> => {
      const response = await completeSimple(
        model,
        { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
        {
          apiKey: config.apiKey?.trim() || CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
          fetch: fetchForTest,
          maxTokens: Math.min(32, model.maxTokens),
          signal: controller.signal,
          timeoutMs: TEST_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: "none",
          onResponse: (response) => { status = response.status; },
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return failure();
      }
      if (!response.content.some((part) => part.type === "text" && part.text.trim())) {
        return { ok: false, error: "Model availability test returned no text." };
      }
      return { ok: true };
    };
    return await Promise.race([request(), timeout]);
  } catch {
    return failure();
  } finally {
    clearTimeout(timer);
  }
}
