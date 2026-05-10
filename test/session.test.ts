import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SESSION_CONFIG,
  SessionPinStore,
  SessionStore,
  deriveSessionId,
  hashRequestContent,
} from "../src/session.js";
import type { Tier, TierConfig } from "../src/router/types.js";

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

  it("stores actual model and tier", () => {
    const store = new SessionStore();

    try {
      store.setSession("s1", "deepseek-v4-flash", "MEDIUM");
      expect(store.getSession("s1")).toMatchObject({ model: "deepseek-v4-flash", tier: "MEDIUM" });

      store.setSession("s1", "deepseek-v4-pro", "MEDIUM");
      expect(store.getSession("s1")).toMatchObject({ model: "deepseek-v4-pro", tier: "MEDIUM" });
    } finally {
      store.close();
    }
  });

  it("preserves userExplicit once set", () => {
    const store = new SessionStore();

    try {
      store.setSession("s1", "deepseek-v4-flash", "MEDIUM", true);
      store.setSession("s1", "deepseek-v4-pro", "COMPLEX");

      expect(store.getSession("s1")?.userExplicit).toBe(true);
    } finally {
      store.close();
    }
  });

  it("does nothing when disabled", () => {
    const store = new SessionStore({ enabled: false });

    try {
      store.setSession("s1", "deepseek-v4-pro", "COMPLEX", true);

      expect(store.getSession("s1")).toBeUndefined();
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.getStats()).toMatchObject({ size: 0, enabled: false });
    } finally {
      store.close();
    }
  });

  it("supports touch, clearSession, clearAll, and stats", () => {
    const store = new SessionStore();

    try {
      store.setSession("s1", "deepseek-v4-flash", "MEDIUM");
      store.setSession("s2", "deepseek-v4-pro", "COMPLEX", true);

      expect(store.touchSession("s1")).toBe(true);
      expect(store.touchSession("missing")).toBe(false);
      expect(store.getStats()).toMatchObject({ size: 2, explicit: 1, escalated: 0, enabled: true });

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
      store.setSession("s1", "deepseek-v4-flash", "MEDIUM");
      expect(store.getSession("s1")).toBeDefined();

      vi.advanceTimersByTime(101);
      expect(store.getSession("s1")).toBeUndefined();

      store.setSession("s2", "deepseek-v4-flash", "MEDIUM");
      vi.advanceTimersByTime(150);
      expect(store.getStats().size).toBe(0);
    } finally {
      store.close();
    }
  });

  it("uses a default config with TTL, cleanup, and enabled session tracking", () => {
    expect(DEFAULT_SESSION_CONFIG).toMatchObject({
      enabled: true,
      maxSameRequestStrikes: 3,
    });
    expect(DEFAULT_SESSION_CONFIG.ttlMs).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_CONFIG.cleanupIntervalMs).toBeGreaterThan(0);
  });

  it("triggers three-strike escalation once and resets strikes", () => {
    const store = new SessionStore();
    const tierConfigs: Record<Tier, TierConfig> = {
      SIMPLE: { primary: "deepseek-v4-flash", fallback: [] },
      MEDIUM: { primary: "deepseek-v4-flash", fallback: ["deepseek-v4-pro"] },
      COMPLEX: { primary: "deepseek-v4-pro", fallback: [] },
      REASONING: { primary: "deepseek-v4-pro", fallback: [] },
    };

    try {
      store.setSession("s1", "deepseek-v4-flash", "MEDIUM");

      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.recordRequestHash("s1", "aaa")).toBe(true);
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.escalateSession("s1", tierConfigs)).toEqual({
        model: "deepseek-v4-pro",
        tier: "COMPLEX",
      });
      expect(store.getSession("s1")).toMatchObject({
        model: "deepseek-v4-pro",
        tier: "COMPLEX",
        escalated: true,
      });
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
      expect(store.recordRequestHash("s1", "aaa")).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("SessionPinStore", () => {
  it("preserves explicit pro tier observations", () => {
    const pins = new SessionPinStore();

    try {
      pins.observe("reasoning-session", "deepseek-v4-pro", "REASONING");
      pins.observe("medium-session", "deepseek-v4-pro", "MEDIUM");

      expect(pins.getTier("reasoning-session")).toBe("REASONING");
      expect(pins.getTier("medium-session")).toBe("MEDIUM");
    } finally {
      pins.close();
    }
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
