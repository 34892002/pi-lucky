import { providerFetch } from "./provider-fetch";
import { isValidHttpBaseUrl } from "@pi-gui/pi-sdk-driver/custom-provider-types";
import type { CustomProviderProbeInput, CustomProviderProbeResult } from "../../contracts/ipc";

const PROBE_TIMEOUT_MS = 10_000;

export async function probeCustomProviderModels(
  input: CustomProviderProbeInput,
): Promise<CustomProviderProbeResult> {
  if (!isValidHttpBaseUrl(input.baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://." };
  }
  const target = new URL(input.baseUrl.trim());
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<CustomProviderProbeResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, error: "Model discovery timed out after 10 seconds." });
        controller.abort();
      }, PROBE_TIMEOUT_MS);
    });
    const request = async (): Promise<CustomProviderProbeResult> => {
      const headers = new Headers({ Accept: "application/json" });
      const apiKey = input.apiKey?.trim();
      if (input.api === "anthropic-messages") {
        headers.set("anthropic-version", "2023-06-01");
        if (apiKey) headers.set("x-api-key", apiKey);
      } else if (apiKey) {
        headers.set("Authorization", `Bearer ${apiKey}`);
      }
      const response = await providerFetch(target, {
        method: "GET", headers, signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, error: `Model discovery request failed (HTTP ${response.status}).` };
      }
      const payload: unknown = await response.json();
      const data = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
      if (!Array.isArray(data)) {
        return { ok: false, error: 'Model discovery response is missing a "data" array.' };
      }
      const ids = data.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
          return [];
        }
        const id = entry.id.trim();
        return id ? [id] : [];
      });
      return { ok: true, models: [...new Set(ids)].sort() };
    };
    return await Promise.race([request(), timeout]);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "CERT_HAS_EXPIRED") {
      return { ok: false, error: "TLS certificate verification failed. Check the system certificate trust or proxy certificate." };
    }
    // Fetch and parsing errors may contain credentials, URLs, or response contents.
    return { ok: false, error: "Model discovery request failed. Check the endpoint and API key." };
  } finally {
    clearTimeout(timer);
  }
}
