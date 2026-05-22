export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export interface ProxyConfig {
  port: number;
  upstreamUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  trace?: "off" | "summary" | "debug";
}

export interface PhysicalModel {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  toolCalling: boolean;
}

export type PublicModelMetadata = {
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export interface PublicModelRouter {
  kind: "router";
  metadata: PublicModelMetadata;
}

export interface PublicModelAlias {
  kind: "alias";
  candidates: string[];
  selection?: "cheapest" | "first";
  metadata?: PublicModelMetadata;
}

export type PublicModelConfig = PublicModelRouter | PublicModelAlias;

export interface TierEntry {
  publicModel: string;
  fallback?: string[];
}

export interface RoutingSpec {
  tiers: Record<Tier, TierEntry>;
  structuredOutputMinTier?: Tier;
  ambiguousDefaultTier?: Tier;
}

export interface RawConfig {
  version: number;
  proxy: ProxyConfig;
  models: PhysicalModel[];
  publicModels: Record<string, PublicModelConfig>;
  routing: RoutingSpec;
}

export type ConfigSource =
  | { kind: "inline"; config: RawConfig }
  | { kind: "file"; path: string };
