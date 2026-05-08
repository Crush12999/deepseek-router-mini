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
});
