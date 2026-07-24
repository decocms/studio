/**
 * Built-in TriggerStorage implementations.
 *
 * - StudioKV: Persists to Studio's KV API (recommended for production)
 * - JsonFileStorage: Persists to a local JSON file (for dev/simple deployments)
 */

import type { TriggerState, TriggerStorage } from "./triggers.ts";

/** Guards against malformed/partial state crossing the Studio KV HTTP boundary. */
function isTriggerState(value: unknown): value is TriggerState {
  if (!value || typeof value !== "object") return false;
  const { credentials, activeTriggerTypes } = value as Record<string, unknown>;
  if (!Array.isArray(activeTriggerTypes)) return false;
  if (!credentials || typeof credentials !== "object") return false;
  const { callbackUrl, callbackToken } = credentials as Record<string, unknown>;
  return typeof callbackUrl === "string" && typeof callbackToken === "string";
}

// ============================================================================
// StudioKV — backed by Studio's /api/kv endpoint
// ============================================================================

interface StudioKVOptions {
  /** Studio base URL (e.g., "https://studio.example.com") */
  url: string;
  /** API key created in the Studio org */
  apiKey: string;
  /** Key prefix to namespace trigger data (default: "triggers") */
  prefix?: string;
}

/**
 * TriggerStorage backed by Studio's org-scoped KV API.
 *
 * @example
 * ```typescript
 * import { createTriggers } from "@decocms/runtime/triggers";
 * import { StudioKV } from "@decocms/runtime/trigger-storage";
 *
 * const triggers = createTriggers({
 *   definitions: [...],
 *   storage: new StudioKV({
 *     url: process.env.STUDIO_URL!,
 *     apiKey: process.env.STUDIO_API_KEY!,
 *   }),
 * });
 * ```
 */
export class StudioKV implements TriggerStorage {
  private baseUrl: string;
  private apiKey: string;
  private prefix: string;

  constructor(options: StudioKVOptions) {
    this.baseUrl = options.url.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.prefix = options.prefix ?? "triggers";
  }

  private key(connectionId: string): string {
    return `${this.prefix}:${connectionId}`;
  }

  async get(connectionId: string): Promise<TriggerState | null> {
    const res = await fetch(
      `${this.baseUrl}/api/kv/${encodeURIComponent(this.key(connectionId))}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );

    if (res.status === 404) return null;

    if (!res.ok) {
      console.error(`[StudioKV] GET failed: ${res.status} ${res.statusText}`);
      return null;
    }

    let body: { value?: unknown };
    try {
      body = (await res.json()) as { value?: unknown };
    } catch (err) {
      console.error(`[StudioKV] GET returned unparseable JSON:`, err);
      return null;
    }

    if (body.value == null) return null;

    if (!isTriggerState(body.value)) {
      console.error(
        `[StudioKV] GET returned malformed trigger state for connection=${connectionId}`,
      );
      return null;
    }

    return body.value;
  }

  async set(connectionId: string, state: TriggerState): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/kv/${encodeURIComponent(this.key(connectionId))}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(state),
      },
    );

    if (!res.ok) {
      console.error(`[StudioKV] PUT failed: ${res.status} ${res.statusText}`);
    }
  }

  async delete(connectionId: string) {
    const res = await fetch(
      `${this.baseUrl}/api/kv/${encodeURIComponent(this.key(connectionId))}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );

    if (!res.ok && res.status !== 404) {
      console.error(
        `[StudioKV] DELETE failed: ${res.status} ${res.statusText}`,
      );
    }
  }
}

// ============================================================================
// JsonFileStorage — backed by a local JSON file
// ============================================================================

interface JsonFileStorageOptions {
  /** Path to the JSON file (will be created if it doesn't exist) */
  path: string;
}

/**
 * TriggerStorage backed by a local JSON file.
 * Suitable for development and single-instance deployments.
 *
 * @example
 * ```typescript
 * import { createTriggers } from "@decocms/runtime/triggers";
 * import { JsonFileStorage } from "@decocms/runtime/trigger-storage";
 *
 * const triggers = createTriggers({
 *   definitions: [...],
 *   storage: new JsonFileStorage({ path: "./trigger-state.json" }),
 * });
 * ```
 */
export class JsonFileStorage implements TriggerStorage {
  private path: string;
  private cache: Map<string, TriggerState> | null = null;

  constructor(options: JsonFileStorageOptions) {
    this.path = options.path;
  }

  private async load(): Promise<Map<string, TriggerState>> {
    if (this.cache) return this.cache;
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(this.path, "utf-8");
      const data = JSON.parse(raw) as Record<string, TriggerState>;
      this.cache = new Map(Object.entries(data));
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.cache = new Map();
      } else {
        throw err;
      }
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    const data = Object.fromEntries(this.cache ?? new Map());
    const fs = await import("node:fs/promises");
    await fs.writeFile(this.path, JSON.stringify(data, null, 2));
  }

  async get(connectionId: string): Promise<TriggerState | null> {
    const map = await this.load();
    return map.get(connectionId) ?? null;
  }

  async set(connectionId: string, state: TriggerState): Promise<void> {
    const map = await this.load();
    map.set(connectionId, state);
    await this.save();
  }

  async delete(connectionId: string) {
    const map = await this.load();
    map.delete(connectionId);
    await this.save();
  }
}
