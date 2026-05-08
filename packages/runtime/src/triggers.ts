import {
  TriggerConfigureInputSchema,
  TriggerListOutputSchema,
  type TriggerDefinition,
} from "@decocms/bindings/trigger";
import { z, type ZodObject, type ZodRawShape } from "zod";
import type { DefaultEnv } from "./index.ts";
import { createTool, type CreatedTool } from "./tools.ts";

interface CallbackCredentials {
  callbackUrl: string;
  callbackToken: string;
}

interface TriggerState {
  credentials: CallbackCredentials;
  activeTriggerTypes: string[];
}

/**
 * Sentinel used when TRIGGER_CONFIGURE arrives without a `subscriptionId`.
 * Lets studio upgrade independently of MCPs and lets MCPs serve clients on
 * older bindings that don't know how to mint a subscriptionId. The cost is
 * that all such legacy registrations collapse to one slot per connection —
 * the same single-sub limitation the previous version had.
 */
const LEGACY_SUBSCRIPTION_ID = "__default";

/**
 * Storage interface for persisting trigger state across MCP restarts.
 *
 * Each subscription is a unique (connectionId, subscriptionId) pair. The
 * same connectionId may host many independent subscriptions (e.g. one
 * per automation listening to the same event type with different filter
 * params), each with its own callback credentials.
 *
 * Implement this with your storage backend (KV, DB, file system, etc.)
 * and pass it to `createTriggers({ storage })`. The runtime calls `list`
 * during webhook fanout to find every active subscription for a given
 * connection — implementations should make this fast (e.g. KV
 * `list({ prefix })`).
 */
export interface TriggerStorage {
  get(
    connectionId: string,
    subscriptionId: string,
  ): Promise<TriggerState | null>;
  set(
    connectionId: string,
    subscriptionId: string,
    state: TriggerState,
  ): Promise<void>;
  delete(connectionId: string, subscriptionId: string): Promise<void>;
  list(
    connectionId: string,
  ): Promise<Array<{ subscriptionId: string; state: TriggerState }>>;
}

interface TriggerDef<
  TType extends string = string,
  TParams extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
> {
  type: TType;
  description: string;
  params: TParams;
}

interface TriggersOptions<TDefs extends TriggerDef[]> {
  definitions: TDefs;
  storage?: TriggerStorage;
}

interface Triggers<TDefs extends TriggerDef[]> {
  /**
   * Returns TRIGGER_LIST and TRIGGER_CONFIGURE tools
   * ready to be spread into your `withRuntime({ tools })` array.
   */
  tools(): CreatedTool[];

  /**
   * Notify Mesh that an event occurred. Fans out to every subscription
   * registered against `connectionId` whose active types include `type`,
   * POSTing the payload to each subscription's callback URL.
   * Fire-and-forget — errors are logged, not thrown.
   */
  notify<T extends TDefs[number]["type"]>(
    connectionId: string,
    type: T,
    data: Record<string, unknown>,
  ): void;
}

// In-memory cache keyed by `${connectionId}:${subscriptionId}`. Persistent
// storage is the source of truth — the cache exists to avoid a KV round
// trip on hot paths and to survive registrations that arrive before any
// notify happens.
class TriggerStateManager {
  private subscriptions = new Map<string, TriggerState>();
  // Tracks whether we've already loaded all subs for a given connectionId
  // from storage, so notify() doesn't issue redundant `list` calls.
  private listed = new Set<string>();
  private storage: TriggerStorage | null;

  constructor(storage?: TriggerStorage) {
    this.storage = storage ?? null;
  }

  private cacheKey(connectionId: string, subscriptionId: string): string {
    return `${connectionId}\x1f${subscriptionId}`;
  }

  private parseCacheKey(
    key: string,
  ): { connectionId: string; subscriptionId: string } {
    const idx = key.indexOf("\x1f");
    return {
      connectionId: key.slice(0, idx),
      subscriptionId: key.slice(idx + 1),
    };
  }

  async listForConnection(
    connectionId: string,
  ): Promise<Array<{ subscriptionId: string; state: TriggerState }>> {
    if (!this.listed.has(connectionId) && this.storage) {
      const records = await this.storage.list(connectionId);
      for (const { subscriptionId, state } of records) {
        this.subscriptions.set(this.cacheKey(connectionId, subscriptionId), state);
      }
      this.listed.add(connectionId);
    }
    const out: Array<{ subscriptionId: string; state: TriggerState }> = [];
    const prefix = `${connectionId}\x1f`;
    for (const [key, state] of this.subscriptions.entries()) {
      if (key.startsWith(prefix)) {
        const { subscriptionId } = this.parseCacheKey(key);
        out.push({ subscriptionId, state });
      }
    }
    return out;
  }

  async enable(
    connectionId: string,
    subscriptionId: string,
    triggerType: string,
    newCredentials?: CallbackCredentials,
  ): Promise<void> {
    const key = this.cacheKey(connectionId, subscriptionId);
    const existing = this.subscriptions.get(key);
    const credentials = newCredentials ?? existing?.credentials;
    if (!credentials) {
      // First enable for this subscription must include credentials.
      // Without them the callback can't be delivered, so refuse loudly.
      throw new Error(
        `[Triggers] enable(${connectionId}/${subscriptionId}): credentials required on first registration`,
      );
    }
    const types = new Set(existing?.activeTriggerTypes ?? []);
    types.add(triggerType);
    const state: TriggerState = {
      credentials,
      activeTriggerTypes: [...types],
    };
    this.subscriptions.set(key, state);
    if (this.storage) {
      await this.storage.set(connectionId, subscriptionId, state);
    }
  }

  async disable(
    connectionId: string,
    subscriptionId: string,
    triggerType: string,
  ): Promise<void> {
    const key = this.cacheKey(connectionId, subscriptionId);
    let existing = this.subscriptions.get(key);
    if (!existing && this.storage) {
      existing = (await this.storage.get(connectionId, subscriptionId)) ?? undefined;
      if (existing) this.subscriptions.set(key, existing);
    }
    if (!existing) return;

    const types = new Set(existing.activeTriggerTypes);
    types.delete(triggerType);
    if (types.size === 0) {
      this.subscriptions.delete(key);
      if (this.storage) {
        await this.storage.delete(connectionId, subscriptionId);
      }
      return;
    }
    const next: TriggerState = {
      credentials: existing.credentials,
      activeTriggerTypes: [...types],
    };
    this.subscriptions.set(key, next);
    if (this.storage) {
      await this.storage.set(connectionId, subscriptionId, next);
    }
  }
}

/**
 * Create a trigger SDK for your MCP.
 *
 * @example
 * ```typescript
 * import { createTriggers } from "@decocms/runtime/triggers";
 * import { z } from "zod";
 *
 * const triggers = createTriggers({
 *   definitions: [
 *     {
 *       type: "github.push",
 *       description: "Triggered when code is pushed to a repository",
 *       params: z.object({
 *         repo: z.string().describe("Repository full name (owner/repo)"),
 *       }),
 *     },
 *   ],
 *   // Optional: persist trigger state across restarts
 *   storage: myKVStorage,
 * });
 *
 * // In withRuntime:
 * export default withRuntime({
 *   tools: triggers.tools(),
 * });
 *
 * // In webhook handler:
 * triggers.notify(connectionId, "github.push", payload);
 * ```
 */
export function createTriggers<const TDefs extends TriggerDef[]>(
  input: TDefs | TriggersOptions<TDefs>,
): Triggers<TDefs> {
  const { definitions, storage } = Array.isArray(input)
    ? { definitions: input as TDefs, storage: undefined }
    : input;

  const state = new TriggerStateManager(storage);

  const triggerDefinitions: TriggerDefinition[] = definitions.map((def) => {
    const shape = def.params.shape;
    const paramsSchema: Record<
      string,
      { type: "string"; description?: string; enum?: string[] }
    > = {};

    for (const [key, value] of Object.entries(shape)) {
      const zodField = value as z.ZodTypeAny;
      const entry: {
        type: "string";
        description?: string;
        enum?: string[];
      } = {
        type: "string" as const,
        description: zodField.description,
      };

      // Extract enum values from z.enum() schemas
      if ("options" in zodField && Array.isArray(zodField.options)) {
        entry.enum = zodField.options as string[];
      }

      paramsSchema[key] = entry;
    }

    return {
      type: def.type,
      description: def.description,
      paramsSchema,
    };
  });

  const TRIGGER_LIST = createTool({
    id: "TRIGGER_LIST" as const,
    description: "List available trigger definitions",
    inputSchema: z.object({}),
    outputSchema: TriggerListOutputSchema,
    execute: async () => {
      return { triggers: triggerDefinitions };
    },
  });

  const TRIGGER_CONFIGURE = createTool({
    id: "TRIGGER_CONFIGURE" as const,
    description: "Configure a trigger with parameters",
    inputSchema: TriggerConfigureInputSchema,
    outputSchema: z.object({ success: z.boolean() }),
    execute: async ({ context, runtimeContext }) => {
      const connectionId = (runtimeContext?.env as unknown as DefaultEnv)
        ?.MESH_REQUEST_CONTEXT?.connectionId;

      if (!connectionId) {
        throw new Error("Connection ID not available");
      }

      const subscriptionId = context.subscriptionId ?? LEGACY_SUBSCRIPTION_ID;

      if (context.enabled) {
        const creds =
          context.callbackUrl && context.callbackToken
            ? {
                callbackUrl: context.callbackUrl,
                callbackToken: context.callbackToken,
              }
            : undefined;
        await state.enable(connectionId, subscriptionId, context.type, creds);
      } else {
        await state.disable(connectionId, subscriptionId, context.type);
      }

      return { success: true };
    },
  });

  return {
    tools() {
      return [TRIGGER_LIST, TRIGGER_CONFIGURE] as CreatedTool[];
    },

    notify(connectionId, type, data) {
      // Fanout: deliver to every subscription on this connection whose
      // active types include `type`. Fire-and-forget — failures log but
      // don't cascade.
      state
        .listForConnection(connectionId)
        .then((records) => {
          let delivered = 0;
          for (const { state: sub } of records) {
            if (!sub.activeTriggerTypes.includes(type)) continue;
            deliverCallback(sub.credentials, type, data);
            delivered++;
          }
          if (delivered === 0) {
            console.log(
              `[Triggers] No subscriptions for connection=${connectionId} type=${type}, skipping notify`,
            );
          }
        })
        .catch((err) => {
          console.error(
            `[Triggers] Failed to fanout for ${connectionId}/${type}:`,
            err,
          );
        });
    },
  };
}

function deliverCallback(
  credentials: CallbackCredentials,
  type: string,
  data: Record<string, unknown>,
): void {
  fetch(credentials.callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.callbackToken}`,
    },
    body: JSON.stringify({ type, data }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(
          `[Triggers] Callback delivery failed for ${type}: ${res.status} ${res.statusText}`,
        );
      }
    })
    .catch((err) => {
      console.error(`[Triggers] Failed to deliver callback for ${type}:`, err);
    });
}
