import { describe, expect, it } from "vitest";

import { SessionPinStore, deriveSessionId } from "../src/session.js";

describe("session pinning", () => {
  it("pins only pro", () => {
    const store = new SessionPinStore();

    expect(store.get("s1")).toBeUndefined();
    store.observe("s1", "deepseek-v4-flash");
    expect(store.get("s1")).toBeUndefined();
    store.observe("s1", "deepseek-v4-pro");
    expect(store.get("s1")).toBe("deepseek-v4-pro");
  });

  it("can be disabled", () => {
    const store = new SessionPinStore({ enabled: false });
    store.observe("s1", "deepseek-v4-pro");
    expect(store.get("s1")).toBeUndefined();
  });

  it("derives session id from header first", () => {
    expect(deriveSessionId({ "x-session-id": "abc" }, "hello")).toBe("abc");
  });

  it("derives stable content session id without header", () => {
    expect(deriveSessionId({}, "same opening")).toBe(deriveSessionId({}, "same opening"));
    expect(deriveSessionId({}, "different opening")).not.toBe(deriveSessionId({}, "same opening"));
  });

  it("handles x-session-id as string array", () => {
    expect(deriveSessionId({ "x-session-id": ["arr-session", "fallback"] }, "hello")).toBe("arr-session");
  });

  it("returns undefined for empty openingText without header", () => {
    expect(deriveSessionId({}, "")).toBeUndefined();
    expect(deriveSessionId({}, "   ")).toBeUndefined();
  });

  it("falls through to content-based id when header is empty string", () => {
    const id = deriveSessionId({ "x-session-id": "" }, "hello");
    expect(id).toBeDefined();
    expect(id).toMatch(/^content:/);
  });
});
