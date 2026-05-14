/**
 * Configuration schema types for the model registry and routing system.
 */

/**
 * Proxy server configuration
 */
export interface ProxyConfig {
  /** Port number for the proxy server */
  port: number;
  /** Upstream API URL */
  upstreamUrl: string;
  /** Optional API key for upstream authentication */
  apiKey?: string;
  /** Optional custom headers to include in upstream requests */
  headers?: Record<string, string>;
  /** Trace level for debugging (default: "off") */
  trace?: "off" | "summary" | "debug";
}

/**
 * Physical model definition with pricing and capabilities
 */
export interface PhysicalModel {
  /** Unique identifier for the model */
  id: string;
  /** Upstream model name/identifier */
  upstreamModel: string;
  /** Human-readable model name */
  name: string;
  /** Input token price (per million tokens) */
  inputPrice: number;
  /** Output token price (per million tokens) */
  outputPrice: number;
  /** Maximum context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxOutput: number;
  /** Whether the model supports reasoning/thinking */
  reasoning: boolean;
  /** Whether the model supports tool calling */
  toolCalling: boolean;
}

/**
 * Router-based public model configuration
 */
export interface PublicModelRouter {
  kind: "router";
}

/**
 * Alias-based public model configuration with candidate selection
 */
export interface PublicModelAlias {
  kind: "alias";
  /** List of candidate physical model IDs */
  candidates: string[];
  /** Selection strategy for choosing among candidates (default: "cheapest") */
  selection?: "cheapest" | "first";
}

/**
 * Public model configuration (union type)
 */
export type PublicModelConfig = PublicModelRouter | PublicModelAlias;

/**
 * Configuration for a single routing tier
 */
export interface TierConfig {
  /** Public model name to use for this tier */
  publicModel: string;
  /** Optional fallback models if primary fails */
  fallback?: string[];
}

/**
 * Routing configuration with tier definitions and boundaries
 */
export interface RoutingConfig {
  /** Tier-to-model mappings */
  tiers: {
    SIMPLE: TierConfig;
    MEDIUM: TierConfig;
    COMPLEX: TierConfig;
    REASONING: TierConfig;
  };
  /** Score boundaries between tiers */
  tierBoundaries: {
    simpleMedium: number;
    mediumComplex: number;
    complexReasoning: number;
  };
  /** Minimum confidence threshold for routing decisions */
  confidenceThreshold: number;
  /** Minimum tier for structured output requests */
  structuredOutputMinTier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
  /** Default tier when routing is ambiguous */
  ambiguousDefaultTier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";
}

/**
 * Top-level configuration object
 */
export interface RawConfig {
  /** Configuration schema version */
  version: number;
  /** Proxy server configuration */
  proxy: ProxyConfig;
  /** Physical model definitions */
  models: PhysicalModel[];
  /** Public model configurations */
  publicModels: Record<string, PublicModelConfig>;
  /** Routing configuration */
  routing: RoutingConfig;
}

/**
 * Configuration source (union type)
 */
export type ConfigSource =
  | { kind: "inline"; config: RawConfig }
  | { kind: "file"; path: string };
