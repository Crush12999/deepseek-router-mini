import { describe, expect, it } from "vitest";

import { MODEL_ROLES } from "../src/models.js";
import type { RealModelId } from "../src/models.js";
import {
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  normalizeTraceMode,
} from "../src/router/index.js";
import type {
  RouteTraceLog,
  TraceAttempt,
  TraceReason,
} from "../src/router/index.js";

describe("router tracing helper", () => {
  it("normalizes trace modes", () => {
    expect(normalizeTraceMode(undefined)).toBe("off");
    expect(normalizeTraceMode("")).toBe("off");
    expect(normalizeTraceMode("summary")).toBe("summary");
    expect(normalizeTraceMode("debug")).toBe("debug");
    expect(normalizeTraceMode("verbose")).toBe("off");
  });

  it("builds compact trace summaries for auto routes", () => {
    expect(
      buildTraceSummary({
        requestedModel: "auto",
        profile: "agentic",
        tier: "MEDIUM",
        actualModel: MODEL_ROLES.light,
        reason: "first-pass",
        routed: true,
        explicit: false,
        fallback: false,
      }),
    ).toBe("auto:agentic:flash:first-pass");

    expect(
      buildTraceSummary({
        requestedModel: "auto",
        profile: "auto",
        tier: "MEDIUM",
        actualModel: MODEL_ROLES.light,
        reason: "first-pass",
        routed: true,
        explicit: false,
        fallback: false,
      }),
    ).toBe("auto:medium:flash:first-pass");
  });

  it("uses explicit as the request code for non-routed traces", () => {
    expect(
      buildTraceSummary({
        requestedModel: MODEL_ROLES.strong,
        tier: "COMPLEX",
        actualModel: MODEL_ROLES.strong,
        reason: "user",
        routed: false,
        explicit: true,
        fallback: false,
      }),
    ).toBe("explicit:complex:pro:user");
  });

  it("uses explicit as the request code when explicit is true even if routed is true", () => {
    expect(
      buildTraceSummary({
        requestedModel: MODEL_ROLES.strong,
        tier: "COMPLEX",
        actualModel: MODEL_ROLES.strong,
        reason: "user",
        routed: true,
        explicit: true,
        fallback: false,
      }),
    ).toBe("explicit:complex:pro:user");
  });

  it("previews prompts by Unicode code point without splitting Chinese characters", () => {
    expect(getPromptPreview("short prompt")).toBe("short prompt");
    expect(getPromptPreview("  short prompt  ")).toBe("  short prompt  ");

    const prompt = "一二三四五六七八九十abcdefghijklmnop中文测试尾巴";
    const spacedPrompt = "  一二三四五六七八九十abcdefghijklmnop中文测试尾巴  ";

    expect(Array.from(prompt).length).toBeGreaterThan(24);
    expect(getPromptPreview(prompt)).toBe(
      "一二三四五六七八九十...mnop中文测试尾巴",
    );
    expect(getPromptPreview(spacedPrompt)).toBe(
      "  一二三四五六七八...op中文测试尾巴  ",
    );
  });

  it("does not emit trace logs when trace mode is off", () => {
    const writes: string[] = [];

    emitRouteTrace(
      "off",
      {
        trace: "auto:medium:flash:first-pass",
        requestedModel: "auto",
        actualModel: MODEL_ROLES.light,
        tier: "MEDIUM",
        profile: "auto",
        method: "rules",
        routed: true,
        fallback: false,
        sessionAction: "none",
      },
      writes.push.bind(writes),
    );

    expect(writes).toEqual([]);
  });

  it("emits JSON trace logs in debug mode with planned reasons and attempt results", () => {
    const writes: string[] = [];
    const reasons: TraceReason[] = ["reasoning", "error"];
    const attemptModels: RealModelId[] = [
      MODEL_ROLES.light,
      MODEL_ROLES.strong,
    ];
    const attempts: TraceAttempt[] = [
      { model: attemptModels[0]!, result: "retryable", status: 429 },
      { model: attemptModels[0]!, result: "network_error" },
      { model: attemptModels[1]!, result: "ok" },
    ];
    const detail: RouteTraceLog = {
      trace: "auto:complex:pro:reasoning",
      requestedModel: "auto",
      actualModel: MODEL_ROLES.strong,
      tier: "COMPLEX",
      profile: "auto",
      method: "rules",
      confidence: 0.75,
      score: 2.5,
      agenticScore: 0,
      routed: true,
      fallback: false,
      attempts,
      sessionAction: "none",
      promptPreview: "Summarize Redis briefly.",
    };

    emitRouteTrace("debug", detail, writes.push.bind(writes));

    expect(writes).toHaveLength(1);
    const logged = JSON.parse(writes[0]!) as RouteTraceLog;
    expect(logged).toMatchObject({
      trace: "auto:complex:pro:reasoning",
      actualModel: MODEL_ROLES.strong,
      attempts,
      promptPreview: "Summarize Redis briefly.",
    });
    expect(reasons).toEqual(["reasoning", "error"]);
  });

  it("emits a single-line trace summary in summary mode", () => {
    const writes: string[] = [];

    emitRouteTrace(
      "summary",
      {
        trace: "auto:medium:flash:first-pass",
        requestedModel: "auto",
        actualModel: MODEL_ROLES.light,
        tier: "MEDIUM",
        profile: "auto",
        method: "rules",
        routed: true,
        fallback: false,
        sessionAction: "none",
      },
      writes.push.bind(writes),
    );

    expect(writes).toEqual([
      "[xiaoyi-router] auto:medium:flash:first-pass model=deepseek-v4-flash fallback=false",
    ]);
  });

  it("does not throw when summary or debug writers fail", () => {
    const writeError = () => {
      throw new Error("log sink failed");
    };
    const detail: RouteTraceLog = {
      trace: "auto:medium:flash:first-pass",
      requestedModel: "auto",
      actualModel: MODEL_ROLES.light,
      tier: "MEDIUM",
      profile: "auto",
      method: "rules",
      routed: true,
      fallback: false,
      sessionAction: "none",
    };

    expect(() => emitRouteTrace("summary", detail, writeError)).not.toThrow();
    expect(() => emitRouteTrace("debug", detail, writeError)).not.toThrow();
  });
});
