export type CustomProviderApi = "openai-completions" | "anthropic-messages";

export function isCustomProviderApi(value: unknown): value is CustomProviderApi {
  return value === "openai-completions" || value === "anthropic-messages";
}

export type CustomModelMaxTokensField = "max_tokens" | "max_completion_tokens";

export type CustomModelThinkingFormat =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "together"
  | "baseten"
  | "zai"
  | "qwen"
  | "chat-template"
  | "qwen-chat-template"
  | "string-thinking"
  | "ant-ling";

export const CUSTOM_MODEL_MAX_TOKENS_FIELDS: readonly CustomModelMaxTokensField[] = [
  "max_completion_tokens",
  "max_tokens",
];

export const CUSTOM_MODEL_THINKING_FORMATS: readonly CustomModelThinkingFormat[] = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
];

export function isCustomModelMaxTokensField(value: unknown): value is CustomModelMaxTokensField {
  return value === "max_tokens" || value === "max_completion_tokens";
}

export function isCustomModelThinkingFormat(value: unknown): value is CustomModelThinkingFormat {
  return (
    typeof value === "string" &&
    (CUSTOM_MODEL_THINKING_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * One model of a custom OpenAI- or Anthropic-compatible endpoint. The optional fields are pi's
 * models.json model definition, limited to what the app can edit: display name,
 * token limits, image input, thinking, and the two compat switches that matter for
 * local/served endpoints.
 */
export interface CustomProviderModelInput {
  readonly id: string;
  readonly name?: string;
  /** Context window in tokens; pi defaults to 128000. */
  readonly contextWindow?: number;
  /** Maximum output tokens; pi defaults to 16384. */
  readonly maxTokens?: number;
  /** Whether the model supports thinking. */
  readonly reasoning?: boolean;
  /** Adds "image" to the input modalities ("text" is always supported). */
  readonly supportsImages?: boolean;
  /** Which request field carries the output limit; pi auto-detects when unset. */
  readonly maxTokensField?: CustomModelMaxTokensField;
  /** Which thinking/reasoning parameter shape to send; pi auto-detects when unset. */
  readonly thinkingFormat?: CustomModelThinkingFormat;
}

export interface CustomProviderInput {
  readonly providerId: string;
  /** Defaults to OpenAI completions for older configurations. */
  readonly api?: CustomProviderApi;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
}

export interface CustomProviderEntry {
  readonly providerId: string;
  readonly api?: CustomProviderApi;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelInput[];
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const OPENAI_COMPLETIONS_API: CustomProviderApi = "openai-completions";

export const CUSTOM_PROVIDER_PLACEHOLDER_API_KEY = "unused";
export const PI_GUI_CUSTOM_PROVIDER_MARKER = "piGuiCustomEndpoint";
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

export function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  } catch {
    return false;
  }
}
