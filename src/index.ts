import { VERSION } from "./proxy.js";
import { registerOpenClawPlugin } from "./plugin.js";
import type { OpenClawPlugin } from "./plugin.js";

export { VERSION } from "./proxy.js";

export { resolveConfig } from "./config.js";
export type { RouterConfig, RouterConfigInput } from "./config.js";
export {
  MODEL_ROLES,
  SUPPORTED_MODEL_IDS,
  XIAOYI_MODELS,
  getDefaultModelForRole,
  getModel,
  getModelContextWindow,
  getModelPricing,
  isRealModel,
  supportsToolCalling,
  supportsVision,
  validateModelId,
} from "./models.js";
export type {
  ModelRole,
  RealModelId,
  SupportedModelId,
  XiaoyiModel,
} from "./models.js";
export {
  DEFAULT_ROUTING_CONFIG,
  RulesStrategy,
  calculateModelCost,
  filterByExcludeList,
  filterByToolCalling,
  filterByVision,
  getFallbackChain,
  getFallbackChainFiltered,
  getStrategy,
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  normalizeTraceMode,
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
  Tier,
  TierConfig,
  RouteTraceLog,
  TraceAttempt,
  TraceMode,
  TraceReason,
  TraceSessionAction,
  TraceSummaryInput,
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
  XIAOYI_OPENCLAW_MODELS,
  XIAOYI_PROVIDER_API,
  XIAOYI_PROVIDER_DESCRIPTION,
  XIAOYI_PROVIDER_ID,
  XIAOYI_PROVIDER_NAME,
  createXiaoyiProvider,
} from "./provider.js";
export type { OpenClawModelDefinition, XiaoyiProvider } from "./provider.js";
export {
  injectXiaoyiModelsConfig,
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
  id: "xiaoyi-router",
  name: "Xiaoyi Router",
  description: "Xiaoyi local routing proxy for OpenClaw",
  version: VERSION,
  register: registerOpenClawPlugin,
};

export default plugin;
