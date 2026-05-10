import type { ScoringConfig, ScoringResult } from "./types.js";

export const LONG_CONTEXT_CHARS = 120_000;

export const SIMPLE_PATTERNS = [
  /\btranslate\b/i,
  /\bsummarize\b/i,
  /\bformat\b/i,
  /\bexplain briefly\b/i,
  /翻译/,
  /总结/,
  /格式化/,
];

export const CODE_PATTERNS = [
  /\bapply_patch\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /\brename\b/i,
  /\bwrite\s+(some\s+)?code\b/i,
  /\bgenerate\s+code\b/i,
  /\bedit\s+(the\s+)?file\b/i,
  /\bimplement\b/i,
  /\b[a-z0-9_-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|kt|swift|rb|php|css|scss|html|yml|yaml)\b/i,
  /代码/,
  /函数/,
];

export const COMPLEX_PATTERNS = [
  /\bdebug\b/i,
  /\bfailing tests?\b/i,
  /\barchitecture\b/i,
  /\brefactor\b/i,
  /\bmultiple files?\b/i,
  /\broot cause\b/i,
  /调试/,
  /测试失败/,
  /架构/,
  /重构/,
  /多文件/,
];

type DimensionScore = { name: string; score: number; signal: string | null };

function scoreTokenCount(
  estimatedTokens: number,
  thresholds: { simple: number; complex: number },
): DimensionScore {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}

function scoreKeywordMatch(
  text: string,
  keywords: string[],
  name: string,
  signalLabel: string,
  thresholds: { low: number; high: number },
  scores: { none: number; low: number; high: number },
): DimensionScore {
  const matches = keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return { name, score: scores.high, signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})` };
  }
  if (matches.length >= thresholds.low) {
    return { name, score: scores.low, signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})` };
  }
  return { name, score: scores.none, signal: null };
}

function scoreMultiStep(text: string): DimensionScore {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  return patterns.some((pattern) => pattern.test(text))
    ? { name: "multiStepPatterns", score: 0.5, signal: "multi-step" }
    : { name: "multiStepPatterns", score: 0, signal: null };
}

function scoreQuestionComplexity(prompt: string): DimensionScore {
  const count = (prompt.match(/\?/g) ?? []).length;
  return count > 3
    ? { name: "questionComplexity", score: 0.5, signal: `${count} questions` }
    : { name: "questionComplexity", score: 0, signal: null };
}

function scoreAgenticTask(
  text: string,
  keywords: string[],
): { dimensionScore: DimensionScore; agenticScore: number } {
  let matchCount = 0;
  const signals: string[] = [];

  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) signals.push(keyword);
    }
  }

  if (matchCount >= 4) {
    return {
      dimensionScore: { name: "agenticTask", score: 1, signal: `agentic (${signals.join(", ")})` },
      agenticScore: 1,
    };
  }
  if (matchCount >= 3) {
    return {
      dimensionScore: { name: "agenticTask", score: 0.6, signal: `agentic (${signals.join(", ")})` },
      agenticScore: 0.6,
    };
  }
  if (matchCount >= 1) {
    return {
      dimensionScore: { name: "agenticTask", score: 0.2, signal: `agentic-light (${signals.join(", ")})` },
      agenticScore: 0.2,
    };
  }

  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0,
  };
}

export function classifyByRules(
  prompt: string,
  _systemPrompt: string | undefined,
  estimatedTokens: number,
  config: ScoringConfig,
): ScoringResult {
  const userText = prompt.toLowerCase();
  const dimensions: DimensionScore[] = [
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(userText, config.codeKeywords, "codePresence", "code", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 1 }),
    scoreKeywordMatch(userText, config.reasoningKeywords, "reasoningMarkers", "reasoning", { low: 1, high: 2 }, { none: 0, low: 0.7, high: 1 }),
    scoreKeywordMatch(userText, config.technicalKeywords, "technicalTerms", "technical", { low: 2, high: 4 }, { none: 0, low: 0.5, high: 1 }),
    scoreKeywordMatch(userText, config.creativeKeywords, "creativeMarkers", "creative", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.7 }),
    scoreKeywordMatch(userText, config.simpleKeywords, "simpleIndicators", "simple", { low: 1, high: 2 }, { none: 0, low: -1, high: -1 }),
    scoreMultiStep(userText),
    scoreQuestionComplexity(prompt),
    scoreKeywordMatch(userText, config.imperativeVerbs, "imperativeVerbs", "imperative", { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.constraintIndicators, "constraintCount", "constraints", { low: 1, high: 3 }, { none: 0, low: 0.3, high: 0.7 }),
    scoreKeywordMatch(userText, config.outputFormatKeywords, "outputFormat", "format", { low: 1, high: 2 }, { none: 0, low: 0.4, high: 0.7 }),
    scoreKeywordMatch(userText, config.referenceKeywords, "referenceComplexity", "references", { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.negationKeywords, "negationComplexity", "negation", { low: 2, high: 3 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.domainSpecificKeywords, "domainSpecificity", "domain-specific", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.8 }),
  ];

  const agenticResult = scoreAgenticTask(userText, config.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);

  const signals = dimensions.filter((dimension) => dimension.signal !== null).map((dimension) => dimension.signal!);
  const weightedScore = dimensions.reduce(
    (score, dimension) => score + dimension.score * (config.dimensionWeights[dimension.name] ?? 0),
    0,
  );

  const reasoningMatches = config.reasoningKeywords.filter((keyword) =>
    userText.includes(keyword.toLowerCase()),
  );
  if (reasoningMatches.length >= 2) {
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(calibrateConfidence(Math.max(weightedScore, 0.3), config.confidenceSteepness), 0.85),
      signals,
      agenticScore: agenticResult.agenticScore,
      dimensions,
    };
  }

  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier: ScoringResult["tier"];
  let distanceFromBoundary: number;

  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(weightedScore - mediumComplex, complexReasoning - weightedScore);
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }

  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);
  if (confidence < config.confidenceThreshold) {
    return {
      score: weightedScore,
      tier: null,
      confidence,
      signals,
      agenticScore: agenticResult.agenticScore,
      dimensions,
    };
  }

  return {
    score: weightedScore,
    tier,
    confidence,
    signals,
    agenticScore: agenticResult.agenticScore,
    dimensions,
  };
}

function calibrateConfidence(distance: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * distance));
}
