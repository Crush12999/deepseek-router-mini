import { describe, expect, it, vi } from "vitest";

import {
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  normalizeTraceMode,
  resolveTraceWriter,
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
        routedModel: "custom-fast",
        actualModel: "deepseek-v4-flash",
        reason: "first-pass",
        routed: true,
        explicit: false,
        fallback: false,
      }),
    ).toBe("auto:agentic:custom-fast:first-pass");

    expect(
      buildTraceSummary({
        requestedModel: "auto",
        profile: "default",
        tier: "MEDIUM",
        routedModel: "deepseek-v4-flash",
        actualModel: "deepseek-v4-flash",
        reason: "first-pass",
        routed: true,
        explicit: false,
        fallback: false,
      }),
    ).toBe("auto:medium:deepseek-v4-flash:first-pass");
  });

  it("uses explicit as the request code for non-routed traces", () => {
    expect(
      buildTraceSummary({
        requestedModel: "deepseek-v4-pro",
        routedModel: "deepseek-v4-pro",
        profile: "default",
        tier: "COMPLEX",
        actualModel: "deepseek-v4-pro",
        reason: "user",
        routed: false,
        explicit: true,
        fallback: false,
      }),
    ).toBe("explicit:complex:deepseek-v4-pro:user");
  });

  it("uses explicit as the request code when explicit is true even if routed is true", () => {
    expect(
      buildTraceSummary({
        requestedModel: "deepseek-v4-pro",
        routedModel: "deepseek-v4-pro",
        profile: "default",
        tier: "COMPLEX",
        actualModel: "deepseek-v4-pro",
        reason: "user",
        routed: true,
        explicit: true,
        fallback: false,
      }),
    ).toBe("explicit:complex:deepseek-v4-pro:user");
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
        trace: "auto:medium:deepseek-v4-flash:first-pass",
        requestedModel: "auto",
        routedModel: "deepseek-v4-flash",
        actualModel: "deepseek-v4-flash",
        tier: "MEDIUM",
        profile: "default",
        reason: "first-pass",
        explicit: false,
        method: "rules",
        confidence: 1,
        score: 0,
        agenticScore: 0,
        routed: true,
        fallback: false,
        attempts: [],
        sessionAction: "none",
      },
      writes.push.bind(writes),
    );

    expect(writes).toEqual([]);
  });

  it("emits JSON trace logs in debug mode with planned reasons and attempt results", () => {
    const writes: string[] = [];
    const reasons: TraceReason[] = ["first-pass", "user", "reasoning", "error"];
    const attempts: TraceAttempt[] = [
      { model: "deepseek-v4-pro", status: "error", error: "upstream_http_429" },
      { model: "deepseek-v4-pro", status: "error", error: "network_error" },
      { model: "deepseek-v4-pro", status: "success" },
    ];
    const detail: RouteTraceLog = {
      trace: "auto:complex:deepseek-v4-pro:reasoning",
      requestedModel: "auto",
      routedModel: "deepseek-v4-pro",
      actualModel: "deepseek-v4-pro",
      tier: "COMPLEX",
      profile: "default",
      reason: "reasoning",
      explicit: false,
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
      trace: "auto:complex:deepseek-v4-pro:reasoning",
      routedModel: "deepseek-v4-pro",
      actualModel: "deepseek-v4-pro",
      attempts,
      promptPreview: "Summarize Redis briefly.",
    });
    expect(reasons).toEqual(["first-pass", "user", "reasoning", "error"]);
  });

  it("emits a single-line trace summary in summary mode", () => {
    const writes: string[] = [];

    emitRouteTrace(
      "summary",
      {
        trace: "auto:medium:deepseek-v4-flash:first-pass",
        requestedModel: "auto",
        routedModel: "deepseek-v4-flash",
        actualModel: "deepseek-v4-flash",
        tier: "MEDIUM",
        profile: "default",
        reason: "first-pass",
        explicit: false,
        method: "rules",
        confidence: 1,
        score: 0,
        agenticScore: 0,
        routed: true,
        fallback: false,
        attempts: [],
        sessionAction: "none",
      },
      writes.push.bind(writes),
    );

    expect(writes).toEqual([
      "[llm-router] auto:medium:deepseek-v4-flash:first-pass model=deepseek-v4-flash fallback=false",
    ]);
  });

  it("does not throw when summary or debug writers fail", () => {
    const writeError = () => {
      throw new Error("log sink failed");
    };
    const detail: RouteTraceLog = {
      trace: "auto:medium:deepseek-v4-flash:first-pass",
      requestedModel: "auto",
      routedModel: "deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      tier: "MEDIUM",
      profile: "default",
      reason: "first-pass",
      explicit: false,
      method: "rules",
      confidence: 1,
      score: 0,
      agenticScore: 0,
      routed: true,
      fallback: false,
      attempts: [],
      sessionAction: "none",
    };

    expect(() => emitRouteTrace("summary", detail, writeError)).not.toThrow();
    expect(() => emitRouteTrace("debug", detail, writeError)).not.toThrow();
  });

  it("prefers logger.debug and falls back to logger.info", () => {
    const debug = vi.fn();
    const info = vi.fn();

    resolveTraceWriter({ debug, info })("debug message");
    expect(debug).toHaveBeenCalledWith("debug message");
    expect(info).not.toHaveBeenCalled();

    resolveTraceWriter({ info })("info message");
    expect(info).toHaveBeenCalledWith("info message");
  });

  it("uses console.debug as the default trace writer instead of console.error", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const detail: RouteTraceLog = {
      trace: "auto:medium:deepseek-v4-flash:first-pass",
      requestedModel: "auto",
      routedModel: "deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      tier: "MEDIUM",
      profile: "default",
      reason: "first-pass",
      explicit: false,
      method: "rules",
      confidence: 1,
      score: 0,
      agenticScore: 0,
      routed: true,
      fallback: false,
      attempts: [],
      sessionAction: "none",
    };

    emitRouteTrace("summary", detail);

    expect(debugSpy).toHaveBeenCalledWith(
      "[llm-router] auto:medium:deepseek-v4-flash:first-pass model=deepseek-v4-flash fallback=false",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
