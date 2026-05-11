import { MODEL_ROLES } from "../models.js";
import type { RealModelId } from "../models.js";
import type { RoutingDecision, Tier } from "./types.js";

export type TraceMode = "off" | "summary" | "debug";
export type TraceReason =
  | "first-pass"
  | "fallback"
  | "user"
  | "reasoning"
  | "escalated"
  | "error";
export type TraceSessionAction =
  | "none"
  | "set"
  | "reuse"
  | "escalate"
  | "clear";

export type TraceAttempt = {
  model: RealModelId;
  result: "ok" | "retryable" | "network_error";
  status?: number;
};

export type TraceSummaryInput = {
  requestedModel: string;
  actualModel: RealModelId;
  tier: Tier;
  profile?: RoutingDecision["profile"];
  reason: TraceReason;
  routed: boolean;
  explicit: boolean;
  fallback: boolean;
};

export type RouteTraceLog = {
  trace: string;
  requestedModel: string;
  actualModel: RealModelId;
  tier: Tier;
  profile?: RoutingDecision["profile"];
  method?: RoutingDecision["method"];
  confidence?: number;
  score?: number;
  agenticScore?: number;
  routed: boolean;
  fallback: boolean;
  attempts?: TraceAttempt[];
  sessionAction: TraceSessionAction;
  promptPreview?: string;
};

type TraceWriter = (message: string) => void;

export function normalizeTraceMode(mode: unknown): TraceMode {
  if (mode === "summary" || mode === "debug") {
    return mode;
  }

  return "off";
}

export function getPromptPreview(prompt: string): string {
  const chars = Array.from(prompt);

  if (chars.length <= 24) {
    return prompt;
  }

  return `${chars.slice(0, 10).join("")}...${chars.slice(-10).join("")}`;
}

export function buildTraceSummary(input: TraceSummaryInput): string {
  return [
    getRequestCode(input),
    getProfileOrTierCode(input),
    input.actualModel === MODEL_ROLES.light ? "flash" : "pro",
    input.reason,
  ].join(":");
}

export function emitRouteTrace(
  mode: TraceMode,
  detail: RouteTraceLog,
  writer: TraceWriter = console.error,
): void {
  if (mode === "off") {
    return;
  }

  if (mode === "summary") {
    try {
      writer(
        `[xiaoyi-router] ${detail.trace} model=${detail.actualModel} fallback=${detail.fallback}`,
      );
    } catch {
      // Tracing is diagnostic only; logging failures must not affect routing.
    }
    return;
  }

  try {
    writer(JSON.stringify(detail));
  } catch {
    // Tracing is diagnostic only; logging failures must not affect routing.
  }
}

function getRequestCode(input: TraceSummaryInput): string {
  if (input.explicit || !input.routed) {
    return "explicit";
  }

  if (input.requestedModel !== "auto") {
    return input.requestedModel;
  }

  return "auto";
}

function getProfileOrTierCode(input: TraceSummaryInput): string {
  if (input.profile === "agentic") {
    return "agentic";
  }

  return input.tier.toLowerCase();
}
