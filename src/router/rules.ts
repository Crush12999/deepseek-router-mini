import type { ScoringConfig, ScoringResult } from "./types.js";

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
type RuleContext = { hasTools?: boolean };

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

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function scoreCodebaseDebugging(text: string, context: RuleContext): DimensionScore {
  const negativeIntentPatterns = [
    /\brewrite\b/,
    /\bsummarize\b/,
    /\bparaphrase\b/,
    /\brephrase\b/,
    /\bpolish\b/,
    /\bwalk through\b/,
    /\boutline\b/,
    /\blabel\b/,
    /\btitle\b/,
    /\bexample\b/,
    /\blist\b/,
    /\bwhat does it mean\b/,
    /\bwhat it means\b/,
    /\bdiscuss\b/,
    /\badvice\b/,
    /改写/,
    /重写/,
    /总结/,
    /概述/,
    /列出/,
    /释义/,
    /润色/,
    /^(please\s+)?(explain|rewrite|describe|summarize|paraphrase|rephrase|polish|walk through|outline|label|title|list)\b.*\b(this|the)\b.*\b(sentence|note|phrase|text|content)\b/,
    /^(explain|describe|rewrite|summarize|paraphrase|rephrase|polish|walk through|outline|label|title|list)\b.*:/,
    /^(请)?(解释|改写|重写|总结|概述|列出|释义|润色|描述|说明)(这句话|这段话|这个\s?note|以下内容|下面内容|：|:)/,
  ];
  const scopePatterns = [
    /\bauth and session files?\b/,
    /\brouter and proxy modules?\b/,
    /\bcodebase\b/,
    /\brepository\b/,
    /\brepo\b/,
    /\bseveral related files?\b/,
    /\bmultiple files?\b/,
    /\bacross (?:the )?repo\b/,
    /\bacross (?:the )?(?:files?|codebase)\b/,
    /\brelevant modules?\b/,
    /\brelated files?\b/,
    /相关模块/,
    /多个文件/,
    /代码库/,
    /仓库/,
    /模块/,
  ];
  const failurePatterns = [
    /\bfind why\b/,
    /\bfigure out why\b/,
    /\binvestigate why\b/,
    /\bwork out why\b/,
    /\broot cause\b/,
    /\bdebug\b.*\bfailing tests?\b/,
    /\bdebug\b.*\bfailing test\b/,
    /\bdebug tests?\b/,
    /\bdebug failures?\b/,
    /\bregression\b/,
    /\bis failing\b/,
    /\bsuite is failing\b/,
    /\bintegration suite is failing\b/,
    /\bwhat broke\b/,
    /\btrace the regression\b/,
    /\bdiagnose\b/,
    /\bisolate\b/,
    /\bstarted failing\b/,
    /\bsuite started failing\b/,
    /\btests started failing\b/,
    /\bsuite breaks?\b/,
    /\bbroken tests?\b/,
    /\btest failures?\b/,
    /\bfailing tests?\b/,
    /测试套件开始失败/,
    /测试失败/,
    /回归/,
    /坏掉/,
    /不通过/,
  ];
  const repairPatterns = [
    /\bpatch(?:es|ed|ing)?\b/,
    /\brepair(?:s|ed|ing)?\b/,
    /\bfix(?:es|ed|ing)?\b/,
  ];
  const verificationPatterns = [
    /\brerun\b/,
    /\brerun the suite\b/,
    /\btests are green\b/,
    /\bmake sure\b/,
    /\bverify\b/,
    /\beverything passes\b/,
    /\bconfirm\b/,
  ];
  const executionIntentPatterns = [
    /\binspect\b/,
    /\bcheck\b/,
    /\bopen\b/,
    /\blook through\b/,
    /\bread\b/,
    /\binvestigate\b/,
    /\bdebug\b/,
    /\btrace\b/,
    /\bdiagnose\b/,
    /\bisolate\b/,
    /\bidentify\b/,
    /\bwork out\b/,
    /\bfind\b/,
    /\bfigure out\b/,
    /\bfix\b/,
    /\bpatch\b/,
    /\brepair\b/,
    /\bverify\b/,
    /\bconfirm\b/,
    /\brerun\b/,
    /检查/,
    /找出/,
    /排查/,
    /调试/,
    /修复/,
    /验证/,
  ];
  const hasScope = hasPattern(text, scopePatterns);
  const hasFailure = hasPattern(text, failurePatterns);
  const hasRepair = hasPattern(text, repairPatterns);
  const hasVerification = hasPattern(text, verificationPatterns);
  const hasExecutionIntent = hasPattern(text, executionIntentPatterns);
  const hasNegativeIntent = hasPattern(text, negativeIntentPatterns);
  const isToolDiagnosis =
    context.hasTools === true && hasScope && hasFailure && hasExecutionIntent;
  const isDirectMultiFileDiagnosis =
    hasScope && hasFailure && hasExecutionIntent && /\bdebug\b/.test(text);
  const isRepairWorkflow =
    hasScope && hasFailure && hasRepair && hasVerification && hasExecutionIntent;

  if (
    !hasNegativeIntent &&
    hasScope &&
    hasFailure &&
    (isToolDiagnosis || isDirectMultiFileDiagnosis || isRepairWorkflow)
  ) {
    const labels = [
      "scope",
      "failure",
      ...(hasRepair ? ["repair"] : []),
      ...(hasVerification ? ["verify"] : []),
      ...(context.hasTools ? ["tools"] : []),
    ];

    return {
      name: "codebaseDebugging",
      score: 1,
      signal: `codebase-debugging (${labels.join(", ")})`,
    };
  }

  return { name: "codebaseDebugging", score: 0, signal: null };
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
  context: RuleContext = {},
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
    scoreCodebaseDebugging(userText, context),
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

  const hasCodebaseDebugging = dimensions.some(
    (dimension) => dimension.name === "codebaseDebugging" && dimension.score > 0,
  );
  if (hasCodebaseDebugging) {
    return {
      score: weightedScore,
      tier: "COMPLEX",
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
