/**
 * Built-in TriggerStorage implementations.
 *
 * - StudioKV: Persists to Mesh/Studio's KV API (recommended for production)
 * - JsonFileStorage: Persists to a local JSON file (for dev/simple deployments)
 *
 * Both implementations key entries by `(connectionId, subscriptionId)` to
 * support multiple independent subscriptions per connection.
 */

import type { TriggerStorage } from "./triggers.ts";

interface TriggerState {
  credentials: { callbackUrl: string; callbackToken: string };
  activeTriggerTypes: string[];
}

// ============================================================================
// StudioKV — backed by Mesh's /api/kv endpoint
// ============================================================================

interface StudioKVOptions {
  /** Mesh/Studio base URL (e.g., "https://studio.example.com") */
  url: string;
  /** API key created in the Studio org */
  apiKey: string;
  /** Key prefix to namespace trigger data (default: "triggers") */
  prefix?: string;
}

/**
 * TriggerStorage backed by Mesh/Studio's org-scoped KV API.
 *
 * Stores one record per subscription, keyed `${prefix}:${connectionId}:${subscriptionId}`.
 * The `list(connectionId)` operation issues a prefix scan via
 * `/api/kv?prefix=...`.
 *
 * @example
 * ```typescript
 * import { createTriggers } from "@decocms/runtime/triggers";
 * import { StudioKV } from "@decocms/runtime/trigger-storage";
 *
 * const triggers = createTriggers({
 *   definitions: [...],
 *   storage: new StudioKV({
 *     url: process.env.MESH_URL!,
 *     apiKey: process.env.MESH_API_KEY!,
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

  private key(connectionId: string, subscriptionId: string): string {
    return `${this.prefix}:${connectionId}:${subscriptionId}`;
  }

  private connectionPrefix(connectionId: string): string {
    return `${this.prefix}:${connectionId}:`;
  }

  async get(connectionId: string, subscriptionId: string) {
    const res = await fetch(
      `${this.baseUrl}/api/kv/${encodeURIComponent(
        this.key(connectionId, subscriptionId),
      )}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );

    if (res.status === 404) return null;

    if (!res.ok) {
      console.error(`[StudioKV] GET failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const body = (await res.json()) as { value?: TriggerState };
    return body.value ?? null;
  }

  async set(
    connectionId: string,
    subscriptionId: string,
    state: TriggerState,
  ) {
    const res = await fetch(
      `${this.baseUrl}/api/kv/${encodeURIComponent(
        this.key(connectionId, subscriptionId),
      )}`,
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

  async delete(connectionId: string, subscriptionId: string) {
    const res = await fetch(
      `${this.baseUrl}/api/kv/${encodeURIComponent(
        this.key(connectionId, subscriptionId),
      )}`,
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

  async list(connectionId: string) {
    const url = new URL(`${this.baseUrl}/api/kv`);
    url.searchParams.set("prefix", this.connectionPrefix(connectionId));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      console.error(`[StudioKV] LIST failed: ${res.status} ${res.statusText}`);
      return [];
    }
    const body = (await res.json()) as {
      items?: Array<{ key: string; value: TriggerState }>;
    };
    const prefix = this.connectionPrefix(connectionId);
    return (body.items ?? []).map((item) => ({
      subscriptionId: item.key.slice(prefix.length),
      state: item.value,
    }));
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
 * Records are keyed `${connectionId}:${subscriptionId}` inside the file.
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

  private compositeKey(connectionId: string, subscriptionId: string): string {
    return `${connectionId}:${subscriptionId}`;
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

  async get(connectionId: string, subscriptionId: string) {
    const map = await this.load();
    return map.get(this.compositeKey(connectionId, subscriptionId)) ?? null;
  }

  async set(
    connectionId: string,
    subscriptionId: string,
    state: TriggerState,
  ) {
    const map = await this.load();
    map.set(this.compositeKey(connectionId, subscriptionId), state);
    await this.save();
  }

  async delete(connectionId: string, subscriptionId: string) {
    const map = await this.load();
    map.delete(this.compositeKey(connectionId, subscriptionId));
    await this.save();
  }

  async list(connectionId: string) {
    const map = await this.load();
    const prefix = `${connectionId}:`;
    const out: Array<{ subscriptionId: string; state: TriggerState }> = [];
    for (const [key, state] of map.entries()) {
      if (key.startsWith(prefix)) {
        out.push({ subscriptionId: key.slice(prefix.length), state });
      }
    }
    return out;
  }
}
