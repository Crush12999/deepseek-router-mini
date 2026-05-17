import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SESSION_CONFIG,
  SessionStore,
  deriveSessionId,
  hashRequestContent,
} from "../src/session.js";

describe("deriveSessionId", () => {
  it("prefers a trimmed x-session-id header over message content", () => {
    expect(deriveSessionId({ "x-session-id": "  abc  " }, [{ role: "user", content: "hello" }])).toBe("abc");
  });

  it("falls back to content when x-session-id is empty", () => {
    const id = deriveSessionId({ "x-session-id": "   " }, [{ role: "user", content: "hello" }]);

    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("uses the first non-empty x-session-id from a string array", () => {
    expect(deriveSessionId({ "x-session-id": ["  ", " arr-session ", "fallback"] }, [])).toBe("arr-session");
  });

  it("derives a stable 8 hex digit id from the first user message", () => {
    const first = { role: "user", content: "what is JSON?" };
    const id = deriveSessionId({}, [first, { role: "assistant", content: "ok" }]);

    expect(id).toBe(deriveSessionId({}, [first]));
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).not.toBe(deriveSessionId({}, [{ role: "user", content: "different" }]));
  });

  it("skips system messages before deriving from the first user message", () => {
    expect(deriveSessionId({}, [{ role: "system", content: "sys" }])).toBeUndefined();
    expect(
      deriveSessionId({}, [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ]),
    ).toMatch(/^[0-9a-f]{8}$/);
  });

  it("concatenates text parts from the first user message", () => {
    expect(
      deriveSessionId({}, [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image_url", image_url: { url: "https://example.test/img.png" } },
            { type: "text", text: "world" },
          ],
        },
      ]),
    ).toBe(deriveSessionId({}, [{ role: "user", content: "hello world" }]));
  });

  it("returns undefined without user content", () => {
    expect(deriveSessionId({}, [])).toBeUndefined();
    expect(deriveSessionId({}, [{ role: "assistant", content: "hello" }])).toBeUndefined();
    expect(deriveSessionId({}, [{ role: "user", content: "   " }])).toBeUndefined();
  });
});

describe("SessionStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores physical model, routed public model, and pinned tier", () => {
    const store = new SessionStore();

    try {
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "SIMPLE",
      });
      expect(store.getSession("s1")).toMatchObject({
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "SIMPLE",
      });

      store.setSession("s1", {
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
      });
      expect(store.getSession("s1")).toMatchObject({
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
      });
    } finally {
      store.close();
    }
  });

  it("preserves createdAt and usage when updating a session", () => {
    vi.useFakeTimers();
    const store = new SessionStore();

    try {
      vi.setSystemTime(1_000);
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "MEDIUM",
      });
      store.recordUsage("s1", { inputTokens: 10, outputTokens: 20, costEstimate: 0.5 });
      const createdAt = store.getSession("s1")?.createdAt;

      vi.setSystemTime(2_000);
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
      });

      expect(store.getSession("s1")).toMatchObject({
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
        createdAt,
        inputTokens: 10,
        outputTokens: 20,
        costEstimate: 0.5,
      });
    } finally {
      store.close();
    }
  });

  it("does nothing when disabled", () => {
    const store = new SessionStore({ enabled: false });

    try {
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
      });

      expect(store.getSession("s1")).toBeUndefined();
      expect(store.getStats()).toMatchObject({ size: 0, enabled: false });
    } finally {
      store.close();
    }
  });

  it("supports touch, clearSession, clearAll, and stats", () => {
    const store = new SessionStore();

    try {
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "MEDIUM",
      });
      store.setSession("s2", {
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
      });

      expect(store.touchSession("s1")).toBe(true);
      expect(store.touchSession("missing")).toBe(false);
      expect(store.getStats()).toMatchObject({ size: 2, enabled: true });

      expect(store.clearSession("s1")).toBe(true);
      expect(store.clearSession("s1")).toBe(false);
      store.clearAll();
      expect(store.getStats().size).toBe(0);
    } finally {
      store.close();
    }
  });

  it("expires sessions by TTL and cleanup interval", () => {
    vi.useFakeTimers();
    const store = new SessionStore({ ttlMs: 100, cleanupIntervalMs: 50 });

    try {
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "MEDIUM",
      });
      expect(store.getSession("s1")).toBeDefined();

      vi.advanceTimersByTime(101);
      expect(store.getSession("s1")).toBeUndefined();

      store.setSession("s2", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "MEDIUM",
      });
      vi.advanceTimersByTime(150);
      expect(store.getStats().size).toBe(0);
    } finally {
      store.close();
    }
  });

  it("does not preserve usage from an expired session when setting the same id again", () => {
    vi.useFakeTimers();
    const store = new SessionStore({ ttlMs: 100, cleanupIntervalMs: 0 });

    try {
      vi.setSystemTime(1_000);
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "MEDIUM",
      });
      store.recordUsage("s1", { inputTokens: 10, outputTokens: 20, costEstimate: 0.5 });

      vi.setSystemTime(1_101);
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
      });

      expect(store.getSession("s1")).toMatchObject({
        physicalModelId: "deepseek-v4-pro",
        routedPublicModel: "pro",
        pinnedTier: "COMPLEX",
        createdAt: 1_101,
        inputTokens: 0,
        outputTokens: 0,
        costEstimate: 0,
      });
    } finally {
      store.close();
    }
  });

  it("extends expiry when a session is touched", () => {
    vi.useFakeTimers();
    const store = new SessionStore({ ttlMs: 100, cleanupIntervalMs: 0 });

    try {
      vi.setSystemTime(1_000);
      store.setSession("s1", {
        physicalModelId: "deepseek-v4-flash",
        routedPublicModel: "flash",
        pinnedTier: "MEDIUM",
      });
      const originalExpiry = store.getSession("s1")?.expiresAt;

      vi.setSystemTime(1_050);
      expect(store.touchSession("s1")).toBe(true);
      expect(store.getSession("s1")?.expiresAt).toBe(1_150);
      expect(store.getSession("s1")?.expiresAt).toBeGreaterThan(originalExpiry ?? 0);
    } finally {
      store.close();
    }
  });

  it("uses a default config with TTL, cleanup, and enabled session tracking", () => {
    expect(DEFAULT_SESSION_CONFIG).toMatchObject({
      enabled: true,
    });
    expect(DEFAULT_SESSION_CONFIG.ttlMs).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_CONFIG.cleanupIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_CONFIG).not.toHaveProperty("maxSameRequestStrikes");
  });
});

describe("hashRequestContent", () => {
  it("normalizes whitespace", () => {
    expect(hashRequestContent("hello   world")).toBe(hashRequestContent("hello world"));
    expect(hashRequestContent(" hello\n\tworld ")).toBe(hashRequestContent("hello world"));
  });

  it("includes sorted tool names", () => {
    expect(hashRequestContent("hello", ["write_file", "read_file"])).toBe(
      hashRequestContent("hello", ["read_file", "write_file"]),
    );
    expect(hashRequestContent("hello", ["read_file"])).not.toBe(hashRequestContent("hello"));
  });
});
