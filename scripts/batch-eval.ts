/**
 * 批量路由评测脚本 — 不调用模型，只测路由决策 + 耗时
 *
 * 用法:
 *   npx tsx scripts/batch-eval.ts <corpus.json> [--format jsonl|csv]
 *
 * 支持两种 corpus.json 格式：
 * 1. 简化格式：
 *   [
 *     { "prompt": "...", "systemPrompt"?: "...", "hasTools"?: boolean }
 *   ]
 *
 * 2. OpenAI Chat 请求格式：
 *   [
 *     {
 *       "messages": [...],
 *       "tools"?: [...],
 *       "max_tokens"?: number,
 *       "max_completion_tokens"?: number
 *     }
 *   ]
 *
 * 注意：该脚本不会实际请求模型，只做本地规则路由。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { route, DEFAULT_ROUTING_CONFIG, getModelPricing } from "../dist/index.js";
import type { RouterOptions, ModelPricing } from "../dist/index.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const PROMPT_PREVIEW_LIMIT = 80;

type OutputFormat = "jsonl" | "csv";

type OpenAIMessageContentPart = {
  type?: string;
  text?: string;
};

type OpenAIMessage = {
  role?: string;
  content?: string | OpenAIMessageContentPart[] | null;
};

type OpenAIRequestItem = {
  messages?: OpenAIMessage[];
  tools?: unknown[];
};

type NormalizedCorpusItem = {
  prompt: string;
  systemPrompt?: string;
  hasTools: boolean;
};

interface EvalRow {
  index: number;
  promptPreview: string;
  model: string;
  tier: string;
  confidence: number;
  score: number;
  agenticScore: number;
  method: string;
  hasTools: boolean;
  elapsedUs: number;
  signals: string;
  fallbackReason: string;
  reasoning: string;
}

type DisplayEvalRow = EvalRow;

const args = process.argv.slice(2);
const corpusArg = args.find((arg) => !arg.startsWith("--"));
const corpusPath = resolve(corpusArg ?? "./corpus.json");
const format = parseOutputFormat(args);
const rawInput: unknown = JSON.parse(readFileSync(corpusPath, "utf-8"));

if (!Array.isArray(rawInput)) {
  throw new Error("corpus.json 必须是一个 JSON 数组");
}

const corpus = rawInput.map((item, index) => normalizeItem(item, index));

const modelPricing: Map<string, ModelPricing> = new Map();
for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"] as const) {
  const pricing = getModelPricing(modelId);
  modelPricing.set(modelId, {
    inputPrice: pricing.inputPrice,
    outputPrice: pricing.outputPrice,
  });
}

const baseOptions: RouterOptions = {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
};

const results: EvalRow[] = [];

for (let i = 0; i < corpus.length; i++) {
  const item = corpus[i];
  const options: RouterOptions = {
    ...baseOptions,
    hasTools: item.hasTools,
  };

  const t0 = performance.now();
  const decision = route(
    item.prompt,
    item.systemPrompt,
    DEFAULT_MAX_OUTPUT_TOKENS,
    options,
  );
  const elapsedUs = Math.round((performance.now() - t0) * 1000);
  const parsedReasoning = parseReasoning(decision.reasoning);

  results.push({
    index: i,
    promptPreview: buildPromptPreview(item.prompt),
    model: decision.model,
    tier: decision.tier,
    confidence: decision.confidence,
    score: decision.score ?? 0,
    agenticScore: decision.agenticScore ?? 0,
    method: decision.method,
    hasTools: item.hasTools,
    elapsedUs,
    signals: parsedReasoning.signals,
    fallbackReason: parsedReasoning.fallbackReason,
    reasoning: decision.reasoning,
  });
}

const displayResults = results.map(toDisplayRow);

const cols = {
  index: 4,
  promptPreview: 30,
  model: 22,
  tier: 10,
  confidence: 6,
  elapsedUs: 8,
};

const header =
  pad("#", cols.index) +
  pad("prompt", cols.promptPreview) +
  pad("model", cols.model) +
  pad("tier", cols.tier) +
  pad("conf", cols.confidence) +
  pad("us", cols.elapsedUs);

console.log(header);
console.log("-".repeat(header.length));

for (const result of displayResults) {
  console.log(
    pad(String(result.index), cols.index) +
      pad(result.promptPreview, cols.promptPreview) +
      pad(result.model, cols.model) +
      pad(result.tier, cols.tier) +
      pad(result.confidence.toFixed(2), cols.confidence) +
      pad(String(result.elapsedUs), cols.elapsedUs),
  );
}

const totalUs = results.reduce((sum, result) => sum + result.elapsedUs, 0);
const modelCounts: Record<string, number> = {};
const tierCounts: Record<string, number> = {};
for (const result of results) {
  modelCounts[result.model] = (modelCounts[result.model] ?? 0) + 1;
  tierCounts[result.tier] = (tierCounts[result.tier] ?? 0) + 1;
}

console.log("\n--- 统计 ---");
console.log(`总数: ${results.length}`);
console.log(
  `总耗时: ${(totalUs / 1000).toFixed(2)}ms  |  平均: ${(totalUs / results.length).toFixed(1)}us/条`,
);
console.log("模型分布:", modelCounts);
console.log("Tier 分布:", tierCounts);

const outputPath = buildOutputPath(corpusPath, format);
writeOutput(outputPath, displayResults, format);
console.log(`\n${format.toUpperCase()} 已写入: ${outputPath}`);

function toDisplayRow(result: EvalRow): DisplayEvalRow {
  return {
    ...result,
    confidence: roundNumber(result.confidence, 4),
    score: roundNumber(result.score, 2),
    agenticScore: roundNumber(result.agenticScore, 2),
  };
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function parseOutputFormat(argsList: string[]): OutputFormat {
  const formatIndex = argsList.indexOf("--format");
  if (formatIndex === -1) {
    return "jsonl";
  }

  const value = argsList[formatIndex + 1];
  if (value === "jsonl" || value === "csv") {
    return value;
  }

  throw new Error("--format 仅支持 jsonl 或 csv");
}

function buildOutputPath(inputPath: string, outputFormat: OutputFormat): string {
  const suffix = outputFormat === "jsonl" ? "_result.jsonl" : "_result.csv";
  return inputPath.replace(/\.json$/i, "") + suffix;
}

function writeOutput(
  outputPath: string,
  rows: DisplayEvalRow[],
  outputFormat: OutputFormat,
): void {
  if (outputFormat === "csv") {
    const csvHeader = "index,prompt_preview,model,tier,confidence,score,agenticScore,method,hasTools,elapsedUs,signals,fallbackReason,reasoning";
    const csvRows = rows.map((result) =>
      [
        result.index,
        quoteCsv(result.promptPreview),
        result.model,
        result.tier,
        result.confidence.toFixed(4),
        result.score.toFixed(2),
        result.agenticScore.toFixed(2),
        result.method,
        result.hasTools,
        result.elapsedUs,
        quoteCsv(result.signals),
        quoteCsv(result.fallbackReason),
        quoteCsv(result.reasoning),
      ].join(","),
    );

    writeFileSync(outputPath, [csvHeader, ...csvRows].join("\n"), "utf-8");
    return;
  }

  const jsonl = rows.map((result) => JSON.stringify(result)).join("\n");
  writeFileSync(outputPath, `${jsonl}\n`, "utf-8");
}

function normalizeItem(item: unknown, index: number): NormalizedCorpusItem {
  if (!item || typeof item !== "object") {
    throw new Error(`第 ${index} 条语料必须是对象`);
  }

  if ("prompt" in item && typeof item.prompt === "string") {
    const hasTools = "hasTools" in item ? Boolean(item.hasTools) : false;
    const systemPrompt =
      "systemPrompt" in item && typeof item.systemPrompt === "string"
        ? item.systemPrompt
        : undefined;

    return {
      prompt: item.prompt,
      systemPrompt,
      hasTools,
    };
  }

  if ("messages" in item && Array.isArray(item.messages)) {
    return normalizeOpenAIRequest(item as OpenAIRequestItem, index);
  }

  throw new Error(
    `第 ${index} 条语料格式不支持：需要 { prompt } 或 { messages }`,
  );
}

function normalizeOpenAIRequest(
  item: OpenAIRequestItem,
  index: number,
): NormalizedCorpusItem {
  const messages = item.messages ?? [];
  let systemPrompt: string | undefined;
  const promptParts: string[] = [];

  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : "";
    const text = extractText(message?.content);
    if (!text) {
      continue;
    }

    if (role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      continue;
    }

    if (role === "user") {
      promptParts.push(text);
    }
  }

  const prompt = promptParts.join("\n\n").trim();
  if (!prompt) {
    throw new Error(`第 ${index} 条 OpenAI 请求没有可用于路由的 user prompt`);
  }

  return {
    prompt,
    systemPrompt,
    hasTools: Array.isArray(item.tools) && item.tools.length > 0,
  };
}

function extractText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseReasoning(reasoning: string): {
  signals: string;
  fallbackReason: string;
} {
  const segments = reasoning.split(" | ").map((segment) => segment.trim()).filter(Boolean);
  const nonScoreSegments = segments.filter((segment) => !segment.startsWith("score="));

  const fallbackSegments = nonScoreSegments.filter(
    (segment) => segment.includes("ambiguous -> default:") || segment.startsWith("upgraded to "),
  );
  const signalSegments = nonScoreSegments.filter(
    (segment) => !fallbackSegments.includes(segment),
  );

  return {
    signals: signalSegments.join("; "),
    fallbackReason: fallbackSegments.join("; "),
  };
}

function buildPromptPreview(prompt: string): string {
  return prompt.slice(0, PROMPT_PREVIEW_LIMIT).replace(/\n/g, "\\n");
}

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function quoteCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
