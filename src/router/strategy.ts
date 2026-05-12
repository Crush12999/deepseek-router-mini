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
    const fullText = `${systemPrompt ?? ""} ${prompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);
    const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring, {
      hasTools: options.hasTools ?? false,
    });

    const { tierConfigs, profile, profileSuffix } = chooseTierConfigs(ruleResult.agenticScore ?? 0, options);

    const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;
    let tier: Tier;
    let confidence: number;
    let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

    if (ruleResult.tier !== null) {
      tier = ruleResult.tier;
      confidence = ruleResult.confidence;
    } else {
      tier = config.overrides.ambiguousDefaultTier;
      confidence = 0.5;
      reasoning += ` | ambiguous -> default: ${tier}`;
    }

    if (hasStructuredOutput) {
      const tierRank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
      const minTier = config.overrides.structuredOutputMinTier;
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
      options.routingProfile,
      ruleResult.agenticScore,
      ruleResult.score,
    );
    return { ...decision, tierConfigs, profile };
  }
}

function chooseTierConfigs(
  agenticScore: number,
  options: RouterOptions,
): {
  tierConfigs: Record<Tier, TierConfig>;
  profile: RoutingDecision["profile"];
  profileSuffix: string;
} {
  const { config, routingProfile } = options;

  if (routingProfile === "eco") {
    return {
      tierConfigs: config.ecoTiers ?? config.tiers,
      profile: "eco",
      profileSuffix: config.ecoTiers ? " | eco" : " | eco (default tiers)",
    };
  }

  if (routingProfile === "premium") {
    return {
      tierConfigs: config.premiumTiers ?? config.tiers,
      profile: "premium",
      profileSuffix: config.premiumTiers ? " | premium" : " | premium (default tiers)",
    };
  }

  const agenticMode = config.overrides.agenticMode;
  const hasTools = options.hasTools ?? false;
  const isAutoAgentic = agenticScore >= 0.5;
  let useAgenticTiers: boolean;

  if (agenticMode === false) {
    useAgenticTiers = false;
  } else if (agenticMode === true) {
    useAgenticTiers = config.agenticTiers != null;
  } else {
    useAgenticTiers = (hasTools || isAutoAgentic) && config.agenticTiers != null;
  }

  return {
    tierConfigs: useAgenticTiers ? config.agenticTiers! : config.tiers,
    profile: useAgenticTiers ? "agentic" : "auto",
    profileSuffix: useAgenticTiers ? ` | agentic${hasTools ? " (tools)" : ""}` : "",
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
