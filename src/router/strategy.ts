import { classifyByRules } from "./rules.js";
import { selectModel } from "./selector.js";
import type {
  RouterOptions,
  RouterStrategy,
  RoutingDecision,
  Tier,
  TierConfig,
} from "./types.js";

/**
 * 基于规则的默认路由策略。
 *
 * 它只负责把 prompt 映射到 tier / alias 决策，不参与 physical model 解析，
 * 因此可以长期保持纯函数式、可测试的语义层逻辑。
 */
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

    // 使用一个非常粗粒度的字符数近似，避免把 tokenizer 引进 Router 内核。
    const fullText = `${systemPrompt ?? ""} ${prompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);
    const ruleResult = classifyByRules(
      prompt,
      systemPrompt,
      estimatedTokens,
      config.scoring,
    );

    const { tierConfigs, profile, profileSuffix } = chooseTierConfigs(options);

    const hasStructuredOutput = systemPrompt
      ? /json|structured|schema/i.test(systemPrompt)
      : false;
    let tier: Tier;
    let confidence: number;
    let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

    // 命中明确规则时直接采用；否则落到配置里的 ambiguous 默认 tier。
    if (ruleResult.tier !== null) {
      tier = ruleResult.tier;
      confidence = ruleResult.confidence;
    } else {
      tier = config.overrides?.ambiguousDefaultTier ?? "MEDIUM";
      confidence = 0.5;
      reasoning += ` | ambiguous -> default: ${tier}`;
    }

    // structured output 请求倾向提升到至少 MEDIUM，避免过度保守地走 SIMPLE。
    if (hasStructuredOutput) {
      const tierRank: Record<Tier, number> = {
        SIMPLE: 0,
        MEDIUM: 1,
        COMPLEX: 2,
        REASONING: 3,
      };
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

/**
 * 预留 profile 扩展点。
 *
 * 当前仓库只使用 default profile，但把结构保留下来，能避免未来新增 profile
 * 时改动 `RulesStrategy.route()` 的主流程。
 */
function chooseTierConfigs(options: RouterOptions | undefined): {
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

/**
 * 从策略注册表中读取命名路由策略。
 */
export function getStrategy(name: string): RouterStrategy {
  const strategy = registry.get(name);
  if (!strategy) {
    throw new Error(`Unknown routing strategy: ${name}`);
  }
  return strategy;
}

/**
 * 允许外部测试或扩展模块注册新的路由策略实现。
 */
export function registerStrategy(strategy: RouterStrategy): void {
  registry.set(strategy.name, strategy);
}
