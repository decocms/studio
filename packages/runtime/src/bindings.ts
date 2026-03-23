import type { CollectionBinding } from "@decocms/bindings/collections";
import type { MCPConnection } from "./connection.ts";
import type { AgentBindingConfig, ResolvedAgentClient } from "./decopilot.ts";
import type { RequestContext } from "./index.ts";
import { type MCPClientFetchStub, MCPClient, type ToolBinder } from "./mcp.ts";
import { z } from "zod";

type ClientContext = Omit<
  RequestContext,
  "ensureAuthenticated" | "state" | "fetchIntegrationMetadata"
>;

export interface Binding<TType extends string = string> {
  __type: TType;
  value: string;
}

/**
 * A registry mapping binding type strings (e.g. "@deco/database") to their ToolBinder definitions.
 * Used by ResolvedBindings to resolve binding types to their corresponding MCP client types.
 *
 * @example
 * ```ts
 * type MyBindings = {
 *   "@deco/database": typeof DATABASE_BINDING;
 *   "@deco/storage": typeof STORAGE_BINDING;
 * };
 * ```
 */
export type BindingRegistry = Record<string, readonly ToolBinder[]>;

/**
 * Function that returns Zod Schema
 */
export const BindingOf = <
  TRegistry extends BindingRegistry,
  TName extends (keyof TRegistry | "*") & z.util.Literal,
>(
  name: TName,
) => {
  return z.object({
    __type: z.literal(name).default(name as any),
    value: z.string(),
  });
};

// ============================================================================
// Agent Bindings
// ============================================================================

const AgentModelInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  capabilities: z
    .object({
      vision: z.boolean().optional(),
      text: z.boolean().optional(),
      tools: z.boolean().optional(),
      reasoning: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  provider: z.string().optional().nullable(),
  limits: z
    .object({
      contextWindow: z.number().optional(),
      maxOutputTokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * Zod schema for agent bindings in the StateSchema.
 * Defines an AI agent with its model config, approval level, and temperature.
 *
 * @example
 * ```ts
 * const stateSchema = z.object({
 *   MY_AGENT: AgentOf(),
 * });
 *
 * // In tools:
 * const stream = await state.MY_AGENT.STREAM({ messages: [...] });
 * for await (const message of stream) { ... }
 * ```
 */
export const AgentOf = () =>
  z.object({
    __type: z.literal("@deco/agent" as const).default("@deco/agent" as const),
    value: z.string(),
    id: z.string().optional(),
    credentialId: z.string().optional(),
    thinking: AgentModelInfoSchema.optional(),
    coding: AgentModelInfoSchema.optional(),
    fast: AgentModelInfoSchema.optional(),
    toolApprovalLevel: z.enum(["auto", "readonly", "plan"]).default("readonly"),
    temperature: z.number().default(0.5),
  });

const isAgent = (v: unknown): v is AgentBindingConfig => {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __type: string }).__type === "@deco/agent"
  );
};

/**
 * Recursively transforms a type T by replacing all Binding instances with their
 * corresponding MCPClientFetchStub based on the __type field.
 *
 * @template T - The source type to transform
 * @template TBindings - A registry mapping binding __type strings to ToolBinder definitions
 *
 * @example
 * ```ts
 * interface State {
 *   db: Binding<"@deco/database">;
 *   items: Array<Binding<"@deco/storage">>;
 *   config: { nested: Binding<"@deco/config"> };
 * }
 *
 * type Resolved = ResolvedBindings<State, {
 *   "@deco/database": typeof DATABASE_BINDING;
 *   "@deco/storage": typeof STORAGE_BINDING;
 * }>;
 * // Result:
 * // {
 * //   db: MCPClientFetchStub<typeof DATABASE_BINDING>;
 * //   items: Array<MCPClientFetchStub<typeof STORAGE_BINDING>>;
 * //   config: { nested: unknown }; // "@deco/config" not in registry
 * // }
 * ```
 */
export type ResolvedBindings<
  T,
  TBindings extends BindingRegistry,
> = T extends AgentBindingConfig
  ? ResolvedAgentClient
  : T extends Binding<infer TType>
    ? TType extends keyof TBindings
      ? MCPClientFetchStub<TBindings[TType]> & { __type: TType; value: string }
      : MCPClientFetchStub<[]> & { __type: string; value: string }
    : T extends Array<infer U>
      ? Array<ResolvedBindings<U, TBindings>>
      : T extends object
        ? { [K in keyof T]: ResolvedBindings<T[K], TBindings> }
        : T;

export const isBinding = (v: unknown): v is Binding => {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { __type: string }).__type === "string" &&
    (v as { __type: string }).__type !== "@deco/agent" &&
    typeof (v as { value: string }).value === "string"
  );
};

export const proxyConnectionForId = (
  connectionId: string,
  ctx: Omit<ClientContext, "token"> & {
    token?: string;
    cookie?: string;
    meshUrl: string;
  },
  appName?: string,
): MCPConnection => {
  let headers: Record<string, string> | undefined = appName
    ? { "x-caller-app": appName }
    : undefined;
  if (ctx.cookie) {
    headers ??= {};
    headers.cookie = ctx.cookie;
  }

  if (ctx.token) {
    headers ??= {};
    headers["x-mesh-token"] = ctx.token;
  }

  return {
    type: "HTTP",
    url: new URL(`/mcp/${connectionId}`, ctx.meshUrl).href,
    token: ctx.token,
    headers,
  };
};

const mcpClientForConnectionId = (
  connectionId: string,
  ctx: ClientContext,
  appName?: string,
) => {
  const mcpConnection = proxyConnectionForId(connectionId, ctx, appName);
  return new Proxy(MCPClient.forConnection(mcpConnection), {
    get(target, name) {
      if (name === "value") {
        return connectionId;
      }
      if (name === "__type") {
        return appName;
      }
      return target[name as keyof typeof target];
    },
  });
};

const createAgentProxy = (
  config: AgentBindingConfig,
  ctx: ClientContext,
): ResolvedAgentClient => {
  const orgSlug = ctx.organizationSlug;
  if (!orgSlug) {
    throw new Error("organizationSlug is required for agent bindings");
  }
  const streamUrl = `${ctx.meshUrl}/api/${orgSlug}/decopilot/runtime/stream`;

  return {
    STREAM: async (params, opts) => {
      const { streamAgent } = await import("./decopilot.ts");
      return streamAgent(streamUrl, ctx.token, config, params, opts);
    },
  };
};

const traverseAndReplace = (obj: unknown, ctx: ClientContext): unknown => {
  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => traverseAndReplace(item, ctx));
  }

  // Handle objects
  if (typeof obj === "object") {
    // Check if this is an agent binding (before connection binding check)
    if (isAgent(obj)) {
      return createAgentProxy(obj, ctx);
    }

    // Check if this is a connection binding
    if (isBinding(obj)) {
      return mcpClientForConnectionId(obj.value, ctx, obj.__type);
    }

    // Traverse object properties
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = traverseAndReplace(value, ctx);
    }
    return result;
  }

  // Return primitives as-is
  return obj;
};

export const initializeBindings = <
  T,
  TBindings extends BindingRegistry = BindingRegistry,
>(
  ctx: RequestContext,
): ResolvedBindings<T, TBindings> => {
  // resolves the state in-place
  return traverseAndReplace(ctx.state, ctx) as ResolvedBindings<T, TBindings>;
};

interface DefaultRegistry extends BindingRegistry {
  "@deco/mesh": CollectionBinding<{ hello: string }, "MESH">;
}

export interface XPTO {
  MESH: Binding<"@deco/meh">;
}

export type XPTOResolved = ResolvedBindings<XPTO, DefaultRegistry>;
