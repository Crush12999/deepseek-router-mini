import { classifyByRules } from "./rules.js";
import { selectModel } from "./selector.js";
import type { RouterOptions, RouterStrategy, RoutingDecision, Tier, TierConfig } from "./types.js";

export class RulesStrategy implements RouterStrategy {
  readonly name = "rules";

  route(
    prompt: string,
    systemPrompt: string | undefined,
    maxOutputTokens: number,
    options: RouterOptions,
  ): RoutingDecision {
    const { config, modelPricing } = options;
    if (!config) {
      throw new Error("Routing config is required at runtime");
    }
    if (!modelPricing) {
      throw new Error("Model pricing is required at runtime");
    }
    const fullText = `${systemPrompt ?? ""} ${prompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);
    const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);

    const { tierConfigs, profile, profileSuffix } = chooseTierConfigs(options);

    const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;
    let tier: Tier;
    let confidence: number;
    let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

    if (ruleResult.tier !== null) {
      tier = ruleResult.tier;
      confidence = ruleResult.confidence;
    } else {
      tier = config.overrides?.ambiguousDefaultTier ?? "MEDIUM";
      confidence = 0.5;
      reasoning += ` | ambiguous -> default: ${tier}`;
    }

    if (hasStructuredOutput) {
      const tierRank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
      const minTier = config.overrides?.structuredOutputMinTier ?? "MEDIUM";
      if (tierRank[tier] < tierRank[minTier]) {
        reasoning += ` | upgraded to ${minTier} (structured output)`;
        tier = minTier;
      } else {
        reasoning += " | structured output";
      }
    }

    reasoning += profileSuffix;

    const decision = selectModel(
      tier,
      confidence,
      "rules",
      reasoning,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
      ruleResult.agenticScore,
      ruleResult.score,
    );
    return { ...decision, tierConfigs, profile };
  }
}

function chooseTierConfigs(
  options: RouterOptions | undefined,
): {
  tierConfigs: Record<Tier, TierConfig>;
  profile: RoutingDecision["profile"];
  profileSuffix: string;
} {
  const config = options?.config;
  if (!config?.tiers) {
    throw new Error("Routing tiers are required at runtime");
  }

  return {
    tierConfigs: config.tiers,
    profile: "default",
    profileSuffix: "",
  };
}

const registry = new Map<string, RouterStrategy>();
registry.set("rules", new RulesStrategy());

export function getStrategy(name: string): RouterStrategy {
  const strategy = registry.get(name);
  if (!strategy) {
    throw new Error(`Unknown routing strategy: ${name}`);
  }
  return strategy;
}

export function registerStrategy(strategy: RouterStrategy): void {
  registry.set(strategy.name, strategy);
}
