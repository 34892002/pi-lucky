import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "@pi-gui/catalogs/node/atomic-write";
import {
  BUILT_IN_PROVIDER_IDS,
  isCustomProviderApi,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isCustomModelMaxTokensField,
  isCustomModelThinkingFormat,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
  type CustomProviderEntry,
  type CustomProviderInput,
  type CustomProviderModelInput,
} from "./custom-provider-types.js";

export type {
  CustomProviderApi,
  CustomModelMaxTokensField,
  CustomModelThinkingFormat,
  CustomProviderEntry,
  CustomProviderInput,
  CustomProviderModelInput,
} from "./custom-provider-types.js";
export {
  BUILT_IN_PROVIDER_IDS,
  isCustomProviderApi,
  CUSTOM_MODEL_MAX_TOKENS_FIELDS,
  CUSTOM_MODEL_THINKING_FORMATS,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
  isCustomModelMaxTokensField,
  isCustomModelThinkingFormat,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  PI_GUI_CUSTOM_PROVIDER_MARKER,
} from "./custom-provider-types.js";

interface ModelsJson extends Record<string, unknown> {
  providers?: Record<string, unknown>;
}

export class CustomProviderStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelsJsonPath: string) {}

  async list(): Promise<readonly CustomProviderEntry[]> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      return readCustomProviders(data);
    });
  }

  async set(input: CustomProviderInput): Promise<void> {
    validateInput(input);
    await this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = ensureProvidersRecord(data);
      const existing = providers[input.providerId];
      if (
        Object.hasOwn(providers, input.providerId) &&
        (!isRecord(existing) || !isPiGuiCustomProviderConfig(input.providerId, existing))
      ) {
        throw new Error(
          `Provider ID "${input.providerId}" already exists in models.json and is not managed by pi-gui.`,
        );
      }
      providers[input.providerId] = toProviderConfig(input);
      await atomicWriteJson(this.modelsJsonPath, data);
    });
  }

  async delete(providerId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const data = await readModelsJson(this.modelsJsonPath);
      const providers = data.providers;
      if (!providers || !Object.hasOwn(providers, providerId)) {
        return false;
      }
      const existing = providers[providerId];
      if (!isRecord(existing) || !isPiGuiCustomProviderConfig(providerId, existing)) {
        return false;
      }
      delete providers[providerId];
      await atomicWriteJson(this.modelsJsonPath, data);
      return true;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function validateInput(input: CustomProviderInput): void {
  if (input.api !== undefined && !isCustomProviderApi(input.api)) {
    throw new Error("Provider api must be openai-completions or anthropic-messages.");
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(input.providerId)) {
    throw new Error(
      `Provider ID must be lowercase alphanumerics or dashes (max 64 chars): ${JSON.stringify(input.providerId)}`,
    );
  }
  if (!isValidHttpBaseUrl(input.baseUrl)) {
    throw new Error(
      `Base URL must start with http:// or https://: ${JSON.stringify(input.baseUrl)}`,
    );
  }
  if (input.models.length === 0) {
    throw new Error("At least one model is required.");
  }
  for (const model of input.models) {
    if (!model.id || typeof model.id !== "string") {
      throw new Error("Model id is required.");
    }
    if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim())) {
      throw new Error(`Model ${model.id} has an empty name.`);
    }
    for (const [field, value] of [
      ["contextWindow", model.contextWindow],
      ["maxTokens", model.maxTokens],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`Model ${model.id} has an invalid ${field}.`);
      }
    }
    for (const [field, value] of [
      ["reasoning", model.reasoning],
      ["supportsImages", model.supportsImages],
    ] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`Model ${model.id} has an invalid ${field}.`);
      }
    }
    if (model.maxTokensField !== undefined && !isCustomModelMaxTokensField(model.maxTokensField)) {
      throw new Error(`Model ${model.id} has an invalid maxTokensField.`);
    }
    if (model.thinkingFormat !== undefined && !isCustomModelThinkingFormat(model.thinkingFormat)) {
      throw new Error(`Model ${model.id} has an invalid thinkingFormat.`);
    }
  }
}

function toProviderConfig(input: CustomProviderInput): Record<string, unknown> {
  const trimmedKey = input.apiKey?.trim();
  return {
    baseUrl: input.baseUrl,
    api: input.api ?? OPENAI_COMPLETIONS_API,
    apiKey: trimmedKey ? trimmedKey : CUSTOM_PROVIDER_PLACEHOLDER_API_KEY,
    [PI_GUI_CUSTOM_PROVIDER_MARKER]: true,
    models: input.models.map((model) => {
      const entry: Record<string, unknown> = { id: model.id };
      if (model.name?.trim()) {
        entry.name = model.name.trim();
      }
      if (model.contextWindow !== undefined) {
        entry.contextWindow = model.contextWindow;
      }
      if (model.maxTokens !== undefined) {
        entry.maxTokens = model.maxTokens;
      }
      if (model.reasoning !== undefined) {
        entry.reasoning = model.reasoning;
      }
      // ["text"] is pi's default, so only an image-capable model needs the field.
      if (model.supportsImages) {
        entry.input = ["text", "image"];
      }
      const compat: Record<string, unknown> = {};
      if (model.maxTokensField !== undefined) {
        compat.maxTokensField = model.maxTokensField;
      }
      if (model.thinkingFormat !== undefined) {
        compat.thinkingFormat = model.thinkingFormat;
      }
      if (
        (input.api ?? OPENAI_COMPLETIONS_API) === OPENAI_COMPLETIONS_API &&
        Object.keys(compat).length > 0
      ) {
        entry.compat = compat;
      }
      return entry;
    }),
  };
}

function readCustomProviders(data: ModelsJson): readonly CustomProviderEntry[] {
  const providers = data.providers;
  if (!providers) {
    return [];
  }
  const entries: CustomProviderEntry[] = [];
  for (const [providerId, rawConfig] of Object.entries(providers)) {
    if (!isRecord(rawConfig)) {
      continue;
    }
    const config = rawConfig;
    if (!isPiGuiCustomProviderConfig(providerId, config)) {
      continue;
    }
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
    if (!baseUrl) {
      continue;
    }
    const models = Array.isArray(config.models)
      ? (config.models as unknown[])
          .map((raw): CustomProviderModelInput | undefined => {
            if (!raw || typeof raw !== "object") {
              return undefined;
            }
            const modelConfig = raw as Record<string, unknown>;
            if (typeof modelConfig.id !== "string" || !modelConfig.id) {
              return undefined;
            }
            const positive = (value: unknown) =>
              typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
            const compat =
              (config.api ?? OPENAI_COMPLETIONS_API) === OPENAI_COMPLETIONS_API &&
              isRecord(modelConfig.compat)
                ? modelConfig.compat
                : undefined;
            const contextWindow = positive(modelConfig.contextWindow);
            const maxTokens = positive(modelConfig.maxTokens);
            const supportsImages = Array.isArray(modelConfig.input)
              ? modelConfig.input.includes("image")
              : undefined;
            return {
              id: modelConfig.id,
              ...(typeof modelConfig.name === "string" && modelConfig.name.trim()
                ? { name: modelConfig.name }
                : {}),
              ...(contextWindow !== undefined ? { contextWindow } : {}),
              ...(maxTokens !== undefined ? { maxTokens } : {}),
              ...(typeof modelConfig.reasoning === "boolean"
                ? { reasoning: modelConfig.reasoning }
                : {}),
              ...(supportsImages !== undefined ? { supportsImages } : {}),
              ...(compat && isCustomModelMaxTokensField(compat.maxTokensField)
                ? { maxTokensField: compat.maxTokensField }
                : {}),
              ...(compat && isCustomModelThinkingFormat(compat.thinkingFormat)
                ? { thinkingFormat: compat.thinkingFormat }
                : {}),
            };
          })
          .filter((entry): entry is CustomProviderModelInput => entry !== undefined)
      : [];
    const rawApiKey = typeof config.apiKey === "string" ? config.apiKey : undefined;
    const apiKey = rawApiKey === CUSTOM_PROVIDER_PLACEHOLDER_API_KEY ? undefined : rawApiKey;
    entries.push({
      providerId,
      ...(isCustomProviderApi(config.api) ? { api: config.api } : {}),
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      models,
    });
  }
  entries.sort((left, right) => left.providerId.localeCompare(right.providerId));
  return entries;
}

function isPiGuiCustomProviderConfig(providerId: string, config: Record<string, unknown>): boolean {
  if (config[PI_GUI_CUSTOM_PROVIDER_MARKER] === true) {
    return true;
  }
  if (BUILT_IN_PROVIDER_IDS.has(providerId)) {
    return false;
  }
  return (
    isCustomProviderApi(config.api) &&
    typeof config.baseUrl === "string" &&
    Array.isArray(config.models) &&
    config.models.length > 0
  );
}

function ensureProvidersRecord(data: ModelsJson): Record<string, unknown> {
  return (data.providers ??= {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readModelsJson(path: string): Promise<ModelsJson> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON. Fix or remove the file before editing custom endpoints from the app. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object at the top level.`);
  }
  if (Object.hasOwn(parsed, "providers") && !isRecord(parsed.providers)) {
    throw new Error(
      `${path} must contain a JSON object for providers. Existing data was not changed.`,
    );
  }
  return { ...parsed, ...(isRecord(parsed.providers) ? { providers: parsed.providers } : {}) };
}

async function atomicWriteJson(path: string, data: Record<string, unknown>): Promise<void> {
  await writeJsonFileAtomic(path, data);
}
