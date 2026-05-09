import { VERSION } from "./proxy.js";
import { registerOpenClawPlugin } from "./plugin.js";
import type { OpenClawPlugin } from "./plugin.js";

export { VERSION } from "./proxy.js";

export { resolveConfig } from "./config.js";
export type { RouterConfig, RouterConfigInput } from "./config.js";
export { DEEPSEEK_MODELS, validateModelId } from "./models.js";
export type { RealModelId, SupportedModelId } from "./models.js";
export { selectModel } from "./router/selector.js";
export type { RouteDecision, RouteInput, TaskCategory } from "./router/types.js";
export { SessionPinStore, deriveSessionId } from "./session.js";
export { startProxy } from "./proxy.js";
export type { ProxyHandle, ProxyOptions } from "./proxy.js";
export {
  DEEPSEEK_OPENCLAW_MODELS,
  DEEPSEEK_PROVIDER_API,
  DEEPSEEK_PROVIDER_ID,
  createDeepSeekProvider,
} from "./provider.js";
export type { DeepSeekProvider, OpenClawModelDefinition } from "./provider.js";
export {
  injectDeepSeekModelsConfig,
  localProviderBaseUrl,
  registerOpenClawPlugin,
} from "./plugin.js";
export type { OpenClawPlugin, OpenClawPluginApi, OpenClawService, PluginRuntime } from "./plugin.js";

const plugin: OpenClawPlugin = {
  id: "deepseek-router-mini",
  name: "DeepSeek Router Mini",
  description: "DeepSeek-only local routing proxy for OpenClaw",
  version: VERSION,
  register: registerOpenClawPlugin,
};

export default plugin;
