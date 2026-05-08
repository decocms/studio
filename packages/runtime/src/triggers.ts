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
 * Storage interface for persisting trigger state across MCP restarts.
 *
 * Implement this with your storage backend (KV, DB, file system, etc.)
 * and pass it to `createTriggers({ storage })`.
 *
 * Keys are connection IDs, values are serializable trigger state objects.
 */
export interface TriggerStorage {
  get(connectionId: string): Promise<TriggerState | null>;
  set(connectionId: string, state: TriggerState): Promise<void>;
  delete(connectionId: string): Promise<void>;
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
   * Notify Mesh that an event occurred.
   * The SDK matches it to stored callback credentials and POSTs to Mesh.
   * Fire-and-forget — errors are logged, not thrown.
   */
  notify<T extends TDefs[number]["type"]>(
    connectionId: string,
    type: T,
    data: Record<string, unknown>,
  ): void;
}

// In-memory cache backed by optional persistent storage
class TriggerStateManager {
  private credentials = new Map<string, CallbackCredentials>();
  private activeTriggers = new Map<string, Set<string>>();
  private storage: TriggerStorage | null;

  constructor(storage?: TriggerStorage) {
    this.storage = storage ?? null;
  }

  getCredentials(connectionId: string): CallbackCredentials | undefined {
    return this.credentials.get(connectionId);
  }

  async loadFromStorage(connectionId: string): Promise<void> {
    if (!this.storage || this.credentials.has(connectionId)) return;
    const state = await this.storage.get(connectionId);
    if (state) {
      this.credentials.set(connectionId, state.credentials);
      this.activeTriggers.set(connectionId, new Set(state.activeTriggerTypes));
    }
  }

  async enable(
    connectionId: string,
    triggerType: string,
    newCredentials?: CallbackCredentials,
  ): Promise<void> {
    if (newCredentials) {
      this.credentials.set(connectionId, newCredentials);
    }

    const types = this.activeTriggers.get(connectionId) ?? new Set();
    types.add(triggerType);
    this.activeTriggers.set(connectionId, types);

    await this.persist(connectionId);
  }

  async disable(connectionId: string, triggerType: string): Promise<void> {
    // Ensure state is loaded (may be empty after restart)
    await this.loadFromStorage(connectionId);
    const types = this.activeTriggers.get(connectionId);
    if (types) {
      types.delete(triggerType);
      if (types.size === 0) {
        this.activeTriggers.delete(connectionId);
        this.credentials.delete(connectionId);
        await this.storage?.delete(connectionId);
        return;
      }
    }

    await this.persist(connectionId);
  }

  private async persist(connectionId: string): Promise<void> {
    if (!this.storage) return;
    const creds = this.credentials.get(connectionId);
    const types = this.activeTriggers.get(connectionId);
    if (!creds || !types || types.size === 0) return;
    await this.storage.set(connectionId, {
      credentials: creds,
      activeTriggerTypes: [...types],
    });
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

      if (context.enabled) {
        const creds =
          context.callbackUrl && context.callbackToken
            ? {
                callbackUrl: context.callbackUrl,
                callbackToken: context.callbackToken,
              }
            : undefined;
        await state.enable(connectionId, context.type, creds);
      } else {
        await state.disable(connectionId, context.type);
      }

      return { success: true };
    },
  });

  return {
    tools() {
      return [TRIGGER_LIST, TRIGGER_CONFIGURE] as CreatedTool[];
    },

    notify(connectionId, type, data) {
      // Try in-memory first, fall back to storage load
      const credentials = state.getCredentials(connectionId);
      if (credentials) {
        deliverCallback(credentials, type, data);
        return;
      }

      // Attempt async load from storage (fire-and-forget)
      state
        .loadFromStorage(connectionId)
        .then(() => {
          const loaded = state.getCredentials(connectionId);
          if (loaded) {
            deliverCallback(loaded, type, data);
          } else {
            console.log(
              `[Triggers] No callback credentials for connection=${connectionId}, skipping notify`,
            );
          }
        })
        .catch((err) => {
          console.error(
            `[Triggers] Failed to load credentials for ${connectionId}:`,
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
