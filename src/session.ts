import { createHash } from "node:crypto";

import type { RealModelId } from "./models.js";

export type SessionPinStoreOptions = {
  enabled?: boolean;
};

export class SessionPinStore {
  private readonly enabled: boolean;
  private readonly pins = new Map<string, RealModelId>();

  constructor(options: SessionPinStoreOptions = {}) {
    this.enabled = options.enabled ?? true;
  }

  get(sessionId: string | undefined): RealModelId | undefined {
    if (!this.enabled || !sessionId) return undefined;
    return this.pins.get(sessionId);
  }

  observe(sessionId: string | undefined, model: RealModelId): void {
    if (!this.enabled || !sessionId) return;
    if (model === "deepseek-v4-pro") {
      this.pins.set(sessionId, model);
    }
  }
}

export function deriveSessionId(
  headers: Record<string, string | string[] | undefined>,
  openingText: string,
): string | undefined {
  const explicit = headers["x-session-id"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (Array.isArray(explicit) && explicit[0]?.trim()) return explicit[0].trim();

  const normalized = openingText.trim().slice(0, 4096);
  if (!normalized) return undefined;

  return `content:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}
