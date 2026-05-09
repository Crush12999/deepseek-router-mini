import { DEFAULT_BASE_URL, DEFAULT_PORT } from "./config.js";
import { startProxy as startProxyImpl } from "./proxy.js";
import type { ProxyHandle, ProxyOptions } from "./proxy.js";
import {
  DEEPSEEK_OPENCLAW_MODELS,
  DEEPSEEK_PROVIDER_API,
  DEEPSEEK_PROVIDER_ID,
  createDeepSeekProvider,
} from "./provider.js";
import type { DeepSeekProvider } from "./provider.js";

type JsonObject = Record<string, unknown>;

export type OpenClawService = {
  id: "deepseek-router-proxy";
  stop: () => Promise<void>;
};

export type OpenClawPluginApi = {
  config: JsonObject;
  pluginConfig?: { port?: unknown; upstreamUrl?: unknown } | Record<string, unknown>;
  registrationMode?: string;
  registerProvider: (provider: DeepSeekProvider) => void;
  registerService: (service: OpenClawService) => void;
  unregisterService?: (id: string) => void | Promise<void>;
  logger?: {
    info?: (message: string) => void;
    error?: (message: string) => void;
  };
};

export type OpenClawPlugin = {
  id: "deepseek-router-mini";
  name: "DeepSeek Router Mini";
  description: "DeepSeek-only local routing proxy for OpenClaw";
  version: string;
  register: (api: OpenClawPluginApi) => Promise<void>;
};

export type PluginRuntime = {
  startProxy: (options: ProxyOptions) => Promise<ProxyHandle>;
};

const defaultRuntime: PluginRuntime = {
  startProxy: startProxyImpl,
};

let activeProxy: ProxyHandle | undefined;
const closedProxies = new WeakSet<ProxyHandle>();
const closingProxies = new WeakMap<ProxyHandle, Promise<void>>();
const RUNTIME_REGISTRATION_MODES = new Set(["full", "runtime", "activate", "active"]);

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

function parsePortValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value >= 65536) return undefined;
    return value;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
  return port;
}

function resolvePluginPort(pluginValue: unknown, envValue: string | undefined): number {
  return parsePortValue(pluginValue) ?? parsePortValue(envValue) ?? DEFAULT_PORT;
}

function parsePluginUpstreamUrl(pluginValue: unknown, envValue: string | undefined): string {
  if (typeof pluginValue === "string" && pluginValue.trim()) {
    return pluginValue;
  }

  return envValue ?? DEFAULT_BASE_URL;
}

function resolvePluginRuntimeConfig(api: OpenClawPluginApi): { port: number; upstreamUrl: string } {
  return {
    port: resolvePluginPort(api.pluginConfig?.port, process.env.DEEPSEEK_ROUTER_PORT),
    upstreamUrl: parsePluginUpstreamUrl(api.pluginConfig?.upstreamUrl, process.env.DEEPSEEK_BASE_URL),
  };
}

function shouldStartRuntimeProxy(registrationMode: string | undefined): boolean {
  if (registrationMode === undefined) return true;
  return RUNTIME_REGISTRATION_MODES.has(registrationMode);
}

async function closeProxyOnce(proxy: ProxyHandle): Promise<void> {
  if (closedProxies.has(proxy)) return;

  const closing = closingProxies.get(proxy);
  if (closing) {
    await closing;
    return;
  }

  const closePromise = (async () => {
    await proxy.close();
    closedProxies.add(proxy);

    if (activeProxy === proxy) {
      activeProxy = undefined;
    }
  })();
  closingProxies.set(proxy, closePromise);

  try {
    await closePromise;
  } finally {
    closingProxies.delete(proxy);
  }
}

function createStopProxy(proxy: ProxyHandle): () => Promise<void> {
  return () => closeProxyOnce(proxy);
}

async function closeActiveProxy(): Promise<void> {
  const previous = activeProxy;
  if (previous) {
    await closeProxyOnce(previous);
  }
}

async function cleanupUnregisteredProxy(proxy: ProxyHandle): Promise<void> {
  try {
    await closeProxyOnce(proxy);
  } finally {
    if (activeProxy === proxy) {
      activeProxy = undefined;
    }
  }
}

function createCleanupFailureError(
  operation: string,
  operationError: unknown,
  cleanupError: unknown,
): AggregateError {
  return new AggregateError(
    [operationError, cleanupError],
    `${operation} failed and proxy cleanup failed`,
    { cause: operationError },
  );
}

async function compensateRegisteredService(
  api: OpenClawPluginApi,
  serviceId: OpenClawService["id"],
  proxy: ProxyHandle,
): Promise<void[]> {
  const errors: unknown[] = [];

  try {
    await cleanupUnregisteredProxy(proxy);
  } catch (error) {
    errors.push(error);
  }

  if (api.unregisterService) {
    try {
      await api.unregisterService(serviceId);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "OpenClaw service compensation failed", { cause: errors[0] });
  }

  return [];
}

async function replaceActiveProxy(proxy: ProxyHandle): Promise<void> {
  const previous = activeProxy;
  if (activeProxy === proxy) {
    return;
  }

  if (previous) {
    await closeProxyOnce(previous);
  }

  activeProxy = proxy;
}

export async function registerOpenClawPlugin(
  api: OpenClawPluginApi,
  runtime: PluginRuntime = defaultRuntime,
): Promise<void> {
  const { port, upstreamUrl } = resolvePluginRuntimeConfig(api);
  const providerBaseUrl = localProviderBaseUrl(port);

  if (!shouldStartRuntimeProxy(api.registrationMode)) {
    api.registerProvider(createDeepSeekProvider(providerBaseUrl));
    injectDeepSeekModelsConfig(api.config, providerBaseUrl);
    return;
  }

  let stopRegisteredProxy: () => Promise<void>;
  let registeredProxy: ProxyHandle;
  try {
    await closeActiveProxy();
    registeredProxy = await runtime.startProxy({ port, baseUrl: upstreamUrl });
    stopRegisteredProxy = createStopProxy(registeredProxy);
    await replaceActiveProxy(registeredProxy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger?.error?.(`DeepSeek Router Mini failed to start on port ${port}: ${message}`);
    throw error;
  }

  try {
    api.registerService({
      id: "deepseek-router-proxy",
      stop: stopRegisteredProxy,
    });
  } catch (error) {
    try {
      await cleanupUnregisteredProxy(registeredProxy);
    } catch (cleanupError) {
      throw createCleanupFailureError("OpenClaw service registration", error, cleanupError);
    }
    throw error;
  }

  try {
    api.registerProvider(createDeepSeekProvider(providerBaseUrl));
  } catch (error) {
    try {
      await compensateRegisteredService(api, "deepseek-router-proxy", registeredProxy);
    } catch (compensationError) {
      const compensationErrors =
        compensationError instanceof AggregateError ? compensationError.errors : [compensationError];
      throw new AggregateError(
        [error, ...compensationErrors],
        "OpenClaw provider registration failed and proxy cleanup failed or service compensation failed",
        { cause: compensationError },
      );
    }
    throw error;
  }

  injectDeepSeekModelsConfig(api.config, providerBaseUrl);

  api.logger?.info?.(`DeepSeek Router Mini listening on ${providerBaseUrl}`);
}
