import { describe, expect, it } from "vitest";

import { classifyPrompt } from "../src/router/classifier.js";
import { selectModel } from "../src/router/selector.js";

describe("router", () => {
  it("routes simple prompts to flash", () => {
    expect(selectModel({ prompt: "Translate hello to Chinese" })).toMatchObject({
      model: "deepseek-v4-flash",
      category: "simple",
    });
  });

  it("routes ordinary code to flash", () => {
    expect(selectModel({ prompt: "Write a TypeScript function that sums numbers." })).toMatchObject({
      model: "deepseek-v4-flash",
      category: "code",
    });
  });

  it("routes tools to pro", () => {
    expect(selectModel({ prompt: "Call the tool", hasTools: true })).toMatchObject({
      model: "deepseek-v4-pro",
      reason: "tools",
    });
  });

  it("routes debugging and failing tests to pro", () => {
    const prompt = "Debug this failing vitest suite across multiple files and propose a fix.";
    expect(classifyPrompt(prompt)).toBe("complex");
    expect(selectModel({ prompt })).toMatchObject({
      model: "deepseek-v4-pro",
      category: "complex",
    });
  });

  it("routes long prompts to pro", () => {
    const prompt = "x".repeat(160_000);
    expect(selectModel({ prompt })).toMatchObject({
      model: "deepseek-v4-pro",
      reason: "long-context",
    });
  });

  it("routes standard (no match) prompts to flash", () => {
    const prompt = "How are you doing today?";
    expect(classifyPrompt(prompt)).toBe("standard");
    expect(selectModel({ prompt })).toMatchObject({
      model: "deepseek-v4-flash",
      category: "standard",
      reason: "standard",
    });
  });

  it("gives complex priority over code when both patterns match", () => {
    const prompt = "Write and debug a TypeScript function";
    expect(classifyPrompt(prompt)).toBe("complex");
    expect(selectModel({ prompt })).toMatchObject({
      model: "deepseek-v4-pro",
      category: "complex",
      reason: "complex",
    });
  });

  it("gives complex priority over simple when both patterns match", () => {
    const prompt = "Debug and explain briefly this failing test";
    expect(classifyPrompt(prompt)).toBe("complex");
  });
});
