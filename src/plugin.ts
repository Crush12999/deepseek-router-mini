import {
  DEEPSEEK_OPENCLAW_MODELS,
  DEEPSEEK_PROVIDER_API,
  DEEPSEEK_PROVIDER_ID,
} from "./provider.js";

type JsonObject = Record<string, unknown>;

function ensureObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const created: JsonObject = {};
    parent[key] = created;
    return created;
  }
  return value as JsonObject;
}

export function localProviderBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

export function injectDeepSeekModelsConfig(config: JsonObject, providerBaseUrl: string): void {
  const models = ensureObject(config, "models");
  const providers = ensureObject(models, "providers");
  const current = providers[DEEPSEEK_PROVIDER_ID];
  const existing =
    current && typeof current === "object" && !Array.isArray(current) ? (current as JsonObject) : {};

  providers[DEEPSEEK_PROVIDER_ID] = {
    ...existing,
    baseUrl: providerBaseUrl,
    api: DEEPSEEK_PROVIDER_API,
    apiKey: existing.apiKey,
    models: DEEPSEEK_OPENCLAW_MODELS,
  };
}
