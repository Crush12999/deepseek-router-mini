import { VERSION } from "./proxy.js";
import { registerOpenClawPlugin } from "./plugin.js";
import type { OpenClawPlugin } from "./plugin.js";

export { VERSION } from "./proxy.js";

export { resolveConfig } from "./config.js";
export type { RouterConfig, RouterConfigInput } from "./config.js";
export { XIAOYI_MODELS, validateModelId } from "./models.js";
export type { RealModelId, SupportedModelId, XiaoyiModel } from "./models.js";
export { selectModel } from "./router/selector.js";
export type { RouteDecision, RouteInput, TaskCategory } from "./router/types.js";
export { SessionPinStore, deriveSessionId } from "./session.js";
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
export type { OpenClawPlugin, OpenClawPluginApi, OpenClawService, PluginRuntime } from "./plugin.js";

const plugin: OpenClawPlugin = {
  id: "xiaoyi-router",
  name: "Xiaoyi Router",
  description: "Xiaoyi local routing proxy for OpenClaw",
  version: VERSION,
  register: registerOpenClawPlugin,
};

export default plugin;
