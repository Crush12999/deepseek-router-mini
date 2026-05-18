import type { Tier } from "./types.js";

export type TraceMode = "off" | "summary" | "debug";
export type TraceReason =
  | "first-pass"
  | "user"
  | "reasoning"
  | "error";
export type TraceSessionAction =
  | "none"
  | "set"
  | "reuse";

export type TraceAttempt = {
  model: string;
  status: "success" | "error";
  error?: string;
};

export type TraceSummaryInput = {
  requestedModel: string;
  routedModel: string;
  actualModel: string;
  tier: Tier;
  profile: string;
  reason: TraceReason;
  routed: boolean;
  explicit: boolean;
  fallback: boolean;
};

export type RouteTraceLog = TraceSummaryInput & {
  trace: string;
  method?: string;
  confidence?: number;
  score?: number;
  agenticScore?: number;
  attempts: TraceAttempt[];
  sessionAction: TraceSessionAction;
  promptPreview?: string;
};

export type TraceWriter = (message: string) => void;
export type TraceLogger = { debug?: TraceWriter; info?: TraceWriter };

function defaultTraceWriter(): TraceWriter {
  return console.debug.bind(console);
}

export function resolveTraceWriter(logger?: TraceLogger): TraceWriter {
  return logger?.debug ?? logger?.info ?? defaultTraceWriter();
}

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
  const requestCode = getRequestCode(input);
  const profileCode = getProfileOrTierCode(input.profile, input.tier);
  return [
    requestCode,
    profileCode,
    input.routedModel,
    input.reason,
  ].join(":");
}

export function emitRouteTrace(
  mode: TraceMode,
  detail: RouteTraceLog,
  writer: TraceWriter = defaultTraceWriter(),
): void {
  if (mode === "off") {
    return;
  }

  if (mode === "summary") {
    try {
      writer(
        `[llm-router] ${detail.trace} model=${detail.actualModel} fallback=${detail.fallback}`,
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

function getProfileOrTierCode(profile: string, tier: Tier): string {
  if (profile === "agentic") {
    return "agentic";
  }

  return tier.toLowerCase();
}
