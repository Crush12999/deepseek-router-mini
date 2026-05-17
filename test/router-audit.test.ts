import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTING_CONFIG,
  buildTraceSummary,
  route,
} from "../src/router/index.js";
import type {
  ModelPricing,
  RouterOptions,
  RoutingConfig,
  RoutingDecision,
  Tier,
  TierConfig,
  TraceReason,
} from "../src/router/index.js";

const pricing: Map<string, ModelPricing> = new Map([
  ["flash", { inputPrice: 0.28, outputPrice: 0.42 }],
  ["pro", { inputPrice: 0.56, outputPrice: 1.68 }],
]);

const TEST_TIERS: Record<Tier, TierConfig> = {
  SIMPLE: { primary: "flash", fallback: [] },
  MEDIUM: { primary: "flash", fallback: ["pro"] },
  COMPLEX: { primary: "pro", fallback: [] },
  REASONING: { primary: "pro", fallback: [] },
};

const TEST_CONFIG: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  tiers: TEST_TIERS,
};

type AuditSample = {
  name: string;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
};

type AuditResult = {
  name: string;
  publicModel: "flash" | "pro";
  tier: RoutingDecision["tier"];
  profile: RoutingDecision["profile"];
  score: number | undefined;
  trace: string;
  reasoning: string;
};

function options(overrides: Partial<RouterOptions> = {}): RouterOptions {
  return {
    config: TEST_CONFIG,
    modelPricing: pricing,
    ...overrides,
  };
}

function expectPublicModel(
  sampleName: string,
  decision: RoutingDecision,
): "flash" | "pro" {
  if (decision.publicModel !== "flash" && decision.publicModel !== "pro") {
    throw new Error(
      `Unexpected routed public model in audit: ${JSON.stringify({
        name: sampleName,
        publicModel: decision.publicModel,
        tier: decision.tier,
        profile: decision.profile,
        score: decision.score,
        reasoning: decision.reasoning,
      })}`,
    );
  }

  return decision.publicModel;
}

function toActualModel(publicModel: "flash" | "pro"): "deepseek-v4-flash" | "deepseek-v4-pro" {
  return publicModel === "flash" ? "deepseek-v4-flash" : "deepseek-v4-pro";
}

function audit(sample: AuditSample): AuditResult {
  const decision = route(
    sample.prompt,
    sample.systemPrompt,
    sample.maxOutputTokens ?? 1024,
    options(),
  );
  const publicModel = expectPublicModel(sample.name, decision);
  const actualModel = toActualModel(publicModel);
  const reason: TraceReason =
    decision.tier === "REASONING" ? "reasoning" : "first-pass";

  return {
    name: sample.name,
    publicModel,
    tier: decision.tier,
    profile: decision.profile,
    score: decision.score,
    trace: buildTraceSummary({
      requestedModel: "auto",
      routedModel: actualModel,
      actualModel,
      tier: decision.tier,
      profile: decision.profile ?? "default",
      reason,
      routed: true,
      explicit: false,
      fallback: false,
    }),
    reasoning: decision.reasoning,
  };
}

describe("OpenClaw route audit", () => {
  it("keeps the non-explicit sample distribution calibrated to 80-96% flash", () => {
    const samples: AuditSample[] = [
      {
        name: "summary",
        prompt: "Summarize this release note in three short bullets.",
      },
      {
        name: "ordinary qa",
        prompt: "What is a reverse proxy and when would I use one?",
      },
      {
        name: "translation",
        prompt: "Translate this sentence to Chinese: The cache warms up quickly.",
      },
      {
        name: "formatting",
        prompt: "Format these key-value pairs as a compact markdown table.",
      },
      {
        name: "light code explanation",
        prompt: "Explain briefly what this TypeScript function returns.",
      },
      {
        name: "small code modification",
        prompt: "Modify the button label in src/App.tsx from Save to Submit.",
      },
      {
        name: "tools request",
        prompt: "Read the file and summarize the config.",
      },
      {
        name: "simple agentic",
        prompt: "Open the README, update the typo, and verify the sentence reads naturally.",
      },
      {
        name: "structured output",
        prompt: "Summarize Redis briefly.",
        systemPrompt: "Return a strict JSON object matching the schema.",
      },
      {
        name: "creative",
        prompt: "Brainstorm five friendly product names for a local router tool.",
      },
      {
        name: "constraints",
        prompt: "Write a commit subject under 50 characters and avoid a trailing period.",
      },
      {
        name: "reference",
        prompt: "Using the docs above, explain the API change in one paragraph.",
      },
      {
        name: "short rewrite",
        prompt: "Rewrite this status update to be clearer and more concise.",
      },
      {
        name: "port config explanation",
        prompt: "Explain what the PORT environment variable controls in this config.",
      },
      {
        name: "error copy polish",
        prompt: "Polish this error message so it sounds calm and actionable.",
      },
      {
        name: "release title",
        prompt: "Create a short release title for faster local model routing.",
      },
      {
        name: "json field meaning",
        prompt: "Explain what the timeoutMs field means in this JSON config.",
      },
      {
        name: "multi-file debugging",
        prompt:
          "Debug failing tests across multiple files, identify the root cause, refactor the architecture, and verify the fix.",
      },
      {
        name: "long context boundary",
        prompt: "a".repeat(128_000 * 4 - 1),
      },
      {
        name: "formal reasoning",
        prompt: "Prove this theorem step by step and derive the result formally.",
      },
      {
        name: "long context",
        prompt: "a".repeat(128_001 * 4),
      },
    ];

    const results = samples.map(audit);
    const flashCount = results.filter(
      (result) => result.publicModel === "flash",
    ).length;
    const flashShare = flashCount / results.length;
    const failureMessage = JSON.stringify(results, null, 2);
    const longContext = results.find((result) => result.name === "long context");
    const longContextBoundary = results.find(
      (result) => result.name === "long context boundary",
    );
    const formalReasoning = results.find(
      (result) => result.name === "formal reasoning",
    );
    const multiFileDebugging = results.find(
      (result) => result.name === "multi-file debugging",
    );
    const simpleAgentic = results.find(
      (result) => result.name === "simple agentic",
    );

    expect(longContext, failureMessage).toMatchObject({
      publicModel: "flash",
      tier: "MEDIUM",
    });
    expect(longContextBoundary, failureMessage).toMatchObject({
      publicModel: "flash",
      tier: "MEDIUM",
    });
    expect(formalReasoning, failureMessage).toMatchObject({
      publicModel: "pro",
      tier: "REASONING",
    });
    expect(multiFileDebugging, failureMessage).toMatchObject({
      profile: "default",
    });
    expect(multiFileDebugging?.tier, failureMessage).not.toBe("REASONING");
    expect(simpleAgentic, failureMessage).toMatchObject({
      publicModel: "flash",
      profile: "default",
    });
    expect(flashShare, failureMessage).toBeGreaterThanOrEqual(0.8);
    expect(flashShare, failureMessage).toBeLessThanOrEqual(0.96);
  });

  it("keeps debugging probes out of reasoning unless they need complex routing", () => {
    const probes: AuditSample[] = [
      {
        name: "short debug diagnosis",
        prompt: "Debug the failing tests and identify the root cause.",
      },
      {
        name: "brief root cause explanation",
        prompt: "Explain the root cause of the failing tests briefly.",
      },
      {
        name: "explain multi-file fix phrase",
        prompt:
          "Explain what it means to fix failing tests in multiple files and verify everything passes.",
      },
      {
        name: "rewrite multi-file fix phrase",
        prompt:
          "Rewrite this sentence: fix failing tests in multiple files and verify everything passes.",
      },
      {
        name: "paraphrase multi-file debug phrase",
        prompt:
          "Paraphrase this note: debug the failing tests across files and verify the fix.",
      },
      {
        name: "summarize multi-file debug phrase",
        prompt:
          "Summarize the failing tests across files and verify the fix in one bullet.",
      },
      {
        name: "list referenced files",
        prompt: "List the files referenced by the failing tests.",
      },
      {
        name: "polish multi-file debug phrase",
        prompt:
          "Polish this note: debug the failing tests across files and verify the fix.",
      },
      {
        name: "describe repo regression phrase",
        prompt:
          "Describe this note: investigate the failing tests across the repo and identify what broke.",
      },
      {
        name: "chinese explain related modules",
        prompt: "解释这句话：检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese rewrite related modules",
        prompt: "改写这句话：检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese summarize related modules",
        prompt: "总结这句话：检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese list related modules",
        prompt: "列出这句话里提到的文件范围：检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese describe related modules",
        prompt: "描述这句话：检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese explain-note related modules",
        prompt: "说明这句话：检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese ordinary qa",
        prompt: "什么是反向代理，什么时候会用到？",
      },
      {
        name: "chinese simple agentic",
        prompt: "打开 README，修正一个错别字，并确认句子读起来自然。",
      },
      {
        name: "chinese short debug diagnosis",
        prompt: "调试失败测试并找出根因。",
      },
      {
        name: "chinese formal reasoning",
        prompt: "逐步证明这个定理，并形式化推导结果。",
      },
      {
        name: "chinese long context boundary",
        prompt: "测".repeat(128_000 * 4 - 1),
      },
      {
        name: "debug tests across files",
        prompt: "Debug tests across files and verify the fix.",
      },
      {
        name: "inspect auth session files",
        prompt:
          "Inspect the auth and session files to find why the integration suite started failing.",
      },
      {
        name: "look through router proxy modules",
        prompt:
          "Look through the router and proxy modules and figure out why the test suite started failing.",
      },
      {
        name: "open related files after config refactor",
        prompt:
          "Open the related files and investigate why the tests started failing after the config refactor.",
      },
      {
        name: "inspect auth session regression",
        prompt:
          "Inspect the auth and session files, trace the regression, and tell me why the integration suite is failing.",
      },
      {
        name: "inspect auth session explain why",
        prompt:
          "Inspect the auth and session files, explain why the integration suite started failing, patch it, and verify the fix.",
      },
      {
        name: "inspect auth session describe why",
        prompt:
          "Inspect the auth and session files, describe why the integration suite started failing, patch it, and verify the fix.",
      },
      {
        name: "check router proxy suite failing",
        prompt:
          "Check the router and proxy modules and work out why the suite is failing after yesterday's refactor.",
      },
      {
        name: "investigate failing tests across repo",
        prompt:
          "Investigate the failing tests across the repo and identify what broke.",
      },
      {
        name: "chinese related modules regression",
        prompt: "检查相关模块，找出为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese explain why related modules",
        prompt: "检查相关模块，说明为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "chinese describe why related modules",
        prompt: "检查相关模块，描述为什么测试套件开始失败，并修复后验证全部通过。",
      },
      {
        name: "inspect relevant modules",
        prompt:
          "Inspect the relevant modules, find why the suite breaks, patch it, and make sure the tests are green.",
      },
      {
        name: "investigate broken tests across codebase",
        prompt:
          "Investigate the broken tests across the codebase, determine what changed, repair it, and rerun the suite.",
      },
      {
        name: "fix failing tests in multiple files",
        prompt: "Fix the failing tests in multiple files and verify everything passes.",
      },
      {
        name: "open related files debug failures",
        prompt: "Open several related files, debug the test failures, and confirm the fix.",
      },
      {
        name: "real e2e debug this failing test across multiple files",
        prompt:
          "Debug this failing test across multiple files and identify the root cause.",
      },
    ];
    const results = probes.map(audit);
    const failureMessage = JSON.stringify(results, null, 2);
    const shortDebugDiagnosis = results.find(
      (result) => result.name === "short debug diagnosis",
    );
    const briefRootCauseExplanation = results.find(
      (result) => result.name === "brief root cause explanation",
    );
    const negativeControlResults = results.filter(
      (result) =>
        result.name === "explain multi-file fix phrase" ||
        result.name === "rewrite multi-file fix phrase" ||
        result.name === "paraphrase multi-file debug phrase" ||
        result.name === "summarize multi-file debug phrase" ||
        result.name === "list referenced files" ||
        result.name === "polish multi-file debug phrase" ||
        result.name === "describe repo regression phrase" ||
        result.name === "chinese explain related modules" ||
        result.name === "chinese rewrite related modules" ||
        result.name === "chinese summarize related modules" ||
        result.name === "chinese list related modules" ||
        result.name === "chinese describe related modules" ||
        result.name === "chinese explain-note related modules",
    );
    const complexRoutingResults = results.filter(
      (result) =>
        result.name === "debug tests across files" ||
        result.name === "inspect auth session files" ||
        result.name === "look through router proxy modules" ||
        result.name === "open related files after config refactor" ||
        result.name === "inspect auth session regression" ||
        result.name === "inspect auth session explain why" ||
        result.name === "inspect auth session describe why" ||
        result.name === "check router proxy suite failing" ||
        result.name === "investigate failing tests across repo" ||
        result.name === "chinese related modules regression" ||
        result.name === "chinese explain why related modules" ||
        result.name === "chinese describe why related modules" ||
        result.name === "inspect relevant modules" ||
        result.name === "investigate broken tests across codebase" ||
        result.name === "fix failing tests in multiple files" ||
        result.name === "open related files debug failures",
    );
    const directMultiFileDiagnosis = results.find(
      (result) => result.name === "real e2e debug this failing test across multiple files",
    );

    expect(shortDebugDiagnosis, failureMessage).toMatchObject({
      publicModel: "flash",
      profile: "default",
    });
    expect(shortDebugDiagnosis?.tier, failureMessage).not.toBe("REASONING");
    expect(briefRootCauseExplanation, failureMessage).toMatchObject({
      publicModel: "flash",
      profile: "default",
    });
    expect(briefRootCauseExplanation?.tier, failureMessage).not.toBe(
      "REASONING",
    );
    for (const result of negativeControlResults) {
      expect(result, failureMessage).toMatchObject({
        publicModel: "flash",
        profile: "default",
      });
      expect(["COMPLEX", "REASONING"], failureMessage).not.toContain(
        result.tier,
      );
      expect(result.reasoning, failureMessage).not.toContain(
        "codebase-debugging",
      );
    }
    for (const result of complexRoutingResults) {
      expect(result, failureMessage).toMatchObject({
        profile: "default",
      });
      expect(result.tier, failureMessage).not.toBe("REASONING");
      expect(result.reasoning, failureMessage).not.toContain(
        "codebase-debugging",
      );
    }
    expect(directMultiFileDiagnosis, failureMessage).toMatchObject({
      publicModel: "flash",
      profile: "default",
    });
    expect(directMultiFileDiagnosis?.tier, failureMessage).not.toBe("REASONING");
    expect(directMultiFileDiagnosis?.reasoning, failureMessage).not.toContain(
      "codebase-debugging",
    );
    expect(
      results.find((result) => result.name === "chinese ordinary qa"),
      failureMessage,
    ).toMatchObject({
      publicModel: "flash",
    });
    expect(
      results.find((result) => result.name === "chinese simple agentic"),
      failureMessage,
    ).toMatchObject({
      publicModel: "flash",
      profile: "default",
    });
    expect(
      results.find((result) => result.name === "chinese short debug diagnosis"),
      failureMessage,
    ).toMatchObject({
      publicModel: "flash",
    });
    expect(
      results.find((result) => result.name === "chinese short debug diagnosis")?.tier,
      failureMessage,
    ).not.toBe("REASONING");
    expect(
      results.find((result) => result.name === "chinese formal reasoning"),
      failureMessage,
    ).toMatchObject({
      publicModel: "pro",
      tier: "REASONING",
    });
    expect(
      results.find((result) => result.name === "chinese long context boundary"),
      failureMessage,
    ).toMatchObject({
      publicModel: "flash",
      tier: "MEDIUM",
    });
  });
});
