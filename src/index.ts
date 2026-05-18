import { VERSION } from "./proxy.js";
import { registerOpenClawPlugin } from "./plugin.js";
import type { OpenClawPlugin } from "./plugin.js";

export { VERSION } from "./proxy.js";

export { resolveConfig } from "./config.js";
export type { RouterConfig, RouterConfigInput } from "./config.js";
export { loadConfig } from "./config-loader.js";
export type {
  ConfigSource,
  PhysicalModel,
  PublicModelConfig,
  PublicModelMetadata,
  RawConfig,
  Tier,
  TierEntry,
} from "./config-schema.js";
export { createModelRegistry } from "./model-registry.js";
export type { ModelRegistry } from "./model-registry.js";
export { resolvePublicModel, resolvePublicModelCandidate } from "./public-model-resolver.js";
export {
  DEFAULT_ROUTING_CONFIG,
  RulesStrategy,
  calculateModelCost,
  filterByExcludeList,
  getFallbackChain,
  getStrategy,
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  normalizeTraceMode,
  resolveTraceWriter,
  registerStrategy,
  route,
  selectModel,
} from "./router/index.js";
export type {
  ModelPricing,
  RouterOptions,
  RouterStrategy,
  RoutingConfig,
  RoutingDecision,
  ScoringConfig,
  ScoringResult,
  TierConfig,
  RouteTraceLog,
  TraceAttempt,
  TraceLogger,
  TraceMode,
  TraceReason,
  TraceSessionAction,
  TraceSummaryInput,
  TraceWriter,
} from "./router/index.js";
export {
  DEFAULT_SESSION_CONFIG,
  SessionStore,
  deriveSessionId,
  hashRequestContent,
} from "./session.js";
export type { SessionConfig, SessionEntry, SessionStats } from "./session.js";
export { startProxy } from "./proxy.js";
export type { ProxyHandle, ProxyOptions } from "./proxy.js";
export {
  LLM_ROUTER_PROVIDER_API,
  LLM_ROUTER_PROVIDER_DESCRIPTION,
  LLM_ROUTER_PROVIDER_ID,
  LLM_ROUTER_PROVIDER_NAME,
  generateOpenClawModels,
} from "./provider.js";
export type { OpenClawModelDefinition } from "./provider.js";
export {
  injectLlmRouterModelsConfig,
  localProviderBaseUrl,
  registerOpenClawPlugin,
} from "./plugin.js";
export type {
  OpenClawPlugin,
  OpenClawPluginApi,
  OpenClawService,
  PluginRuntime,
} from "./plugin.js";

const plugin: OpenClawPlugin = {
  id: "llm-router",
  name: "LLM Router",
  description: "LLM Router local routing proxy for OpenClaw",
  version: VERSION,
  register: registerOpenClawPlugin,
};

export default plugin;
