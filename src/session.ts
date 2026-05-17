import { createHash } from "node:crypto";

import type { Tier } from "./router/types.js";

export type SessionEntry = {
  sessionId: string;
  physicalModelId: string;
  routedPublicModel: string;
  pinnedTier: Tier;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
};

export type SessionConfig = {
  enabled: boolean;
  ttlMs: number;
  cleanupIntervalMs: number;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  enabled: true,
  ttlMs: 30 * 60 * 1000,
  cleanupIntervalMs: 5 * 60 * 1000,
};

export type SessionStats = {
  enabled: boolean;
  size: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostEstimate: number;
};

export class SessionStore {
  private readonly config: SessionConfig;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<SessionConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };

    if (this.config.enabled && this.config.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpired();
      }, this.config.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  getSession(sessionId: string | undefined): SessionEntry | undefined {
    if (!this.config.enabled || !sessionId) return undefined;

    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return entry;
  }

  setSession(
    sessionId: string | undefined,
    input: {
      physicalModelId: string;
      routedPublicModel: string;
      pinnedTier: Tier;
    },
  ): SessionEntry | undefined {
    if (!this.config.enabled || !sessionId) return undefined;

    const now = Date.now();
    const existing = this.getSession(sessionId);
    const entry: SessionEntry = {
      sessionId,
      physicalModelId: input.physicalModelId,
      routedPublicModel: input.routedPublicModel,
      pinnedTier: input.pinnedTier,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + this.config.ttlMs,
      inputTokens: existing?.inputTokens ?? 0,
      outputTokens: existing?.outputTokens ?? 0,
      costEstimate: existing?.costEstimate ?? 0,
    };

    this.sessions.set(sessionId, entry);
    return entry;
  }

  touchSession(sessionId: string | undefined): boolean {
    const entry = this.getSession(sessionId);
    if (!entry) return false;

    const now = Date.now();
    entry.updatedAt = now;
    entry.expiresAt = now + this.config.ttlMs;
    return true;
  }

  clearSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }

  getStats(): SessionStats {
    this.cleanupExpired();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostEstimate = 0;

    for (const entry of this.sessions.values()) {
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
      totalCostEstimate += entry.costEstimate;
    }

    return {
      enabled: this.config.enabled,
      size: this.sessions.size,
      totalInputTokens,
      totalOutputTokens,
      totalCostEstimate,
    };
  }

  recordUsage(
    sessionId: string | undefined,
    usage: { inputTokens?: number; outputTokens?: number; costEstimate?: number },
  ): void {
    const entry = this.getSession(sessionId);
    if (!entry) return;

    entry.inputTokens += usage.inputTokens ?? 0;
    entry.outputTokens += usage.outputTokens ?? 0;
    entry.costEstimate += usage.costEstimate ?? 0;
    entry.updatedAt = Date.now();
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  private cleanupExpired(): void {
    if (!this.config.enabled) return;

    for (const [sessionId, entry] of this.sessions) {
      if (this.isExpired(entry)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private isExpired(entry: SessionEntry): boolean {
    return Date.now() >= entry.expiresAt;
  }
}

export function hashRequestContent(content: string, toolNames: string[] = []): string {
  const normalizedContent = content.trim().replace(/\s+/g, " ");
  const normalizedTools = [...toolNames].map((tool) => tool.trim()).filter(Boolean).sort().join(",");
  return hashHex(`${normalizedContent}\n${normalizedTools}`, 8);
}

export function deriveSessionId(
  headers: Record<string, string | string[] | undefined>,
  messages: unknown[],
): string | undefined {
  const explicit = headers["x-session-id"];
  const explicitId = pickHeaderValue(explicit);
  if (explicitId) return explicitId;

  const firstUserContent = findFirstUserContent(messages);
  if (!firstUserContent) return undefined;

  return hashRequestContent(firstUserContent);
}

function pickHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return undefined;
}

function findFirstUserContent(messages: unknown[]): string | undefined {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const record = message as Record<string, unknown>;
    if (record.role !== "user") continue;

    const text = contentToText(record.content);
    if (text.trim()) return text;
  }

  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

function hashHex(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
