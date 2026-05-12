import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
      expect(store.getStats()).toMatchObject({ size: 2, explicit: 1, enabled: true });

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
    });
    expect(DEFAULT_SESSION_CONFIG.ttlMs).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_CONFIG.cleanupIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_CONFIG).not.toHaveProperty("maxSameRequestStrikes");
  });
});

describe("session model registry coupling", () => {
  it("does not hardcode concrete model ids in session internals", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/session.ts", import.meta.url)), "utf8");

    expect(source).not.toContain('"deepseek-v4-flash"');
    expect(source).not.toContain('"deepseek-v4-pro"');
  });

  it("does not retain repeated-request escalation state", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/session.ts", import.meta.url)), "utf8");

    expect(source).not.toContain("sameRequestStrikes");
    expect(source).not.toContain("maxSameRequestStrikes");
    expect(source).not.toContain("pendingEscalationRequestHash");
    expect(source).not.toContain("lastEscalationRequestHash");
    expect(source).not.toContain("escalateSession");
    expect(source).not.toContain("recordRequestHash");
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
