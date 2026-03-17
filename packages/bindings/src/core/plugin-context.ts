/**
 * Plugin Context Types
 *
 * Provides typed context for plugins to access their selected connection
 * and call tools with full type safety based on the plugin's binding.
 */

import type { Binder, ToolBinder } from "./binder";
import type { z } from "zod";

/**
 * Connection entity shape provided by the layout.
 */
export interface PluginConnectionEntity {
  id: string;
  title: string;
  icon: string | null;
  description: string | null;
  app_name: string | null;
  app_id: string | null;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Organization context.
 */
export interface PluginOrgContext {
  id: string;
  slug: string;
  name: string;
}

/**
 * User session provided to plugins.
 */
export interface PluginSession {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
}

/**
 * Helper type to extract tool by name from a binding.
 */
type ExtractToolByName<TBinding extends Binder, TName extends string> = Extract<
  TBinding[number],
  { name: TName }
>;

/**
 * Typed tool caller for a specific binding.
 * Provides type-safe tool calls based on the binding definition.
 *
 * @template TBinding - The binding type to derive tool types from
 */
export type TypedToolCaller<TBinding extends Binder> = <
  TName extends TBinding[number]["name"] & string,
>(
  toolName: TName,
  args: ExtractToolByName<TBinding, TName> extends ToolBinder<
    TName,
    infer TInput,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    infer _TOutput
  >
    ? TInput extends z.ZodType
      ? z.infer<TInput>
      : TInput
    : unknown,
) => Promise<
  ExtractToolByName<TBinding, TName> extends ToolBinder<
    TName,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    infer _TInput,
    infer TOutput
  >
    ? TOutput extends z.ZodType
      ? z.infer<TOutput>
      : TOutput
    : unknown
>;

/**
 * Base plugin context with connection fields always available.
 * Used by plugin routes where layout guarantees a valid connection.
 *
 * @template TBinding - The binding type the plugin requires
 *
 * @example
 * ```tsx
 * // In plugin route component (connection guaranteed)
 * const { toolCaller, connection } = usePluginContext<typeof REGISTRY_APP_BINDING>();
 *
 * // toolCaller and connection are non-null
 * const result = await toolCaller("REGISTRY_LIST", { limit: 20 });
 * ```
 */
export interface PluginContext<TBinding extends Binder = Binder> {
  /**
   * The selected connection ID.
   * Always defined in routes (layout handles empty state separately).
   */
  connectionId: string;

  /**
   * The selected connection entity.
   * Always defined in routes.
   */
  connection: PluginConnectionEntity;

  /**
   * Typed tool caller for the selected connection.
   * Call MCP tools with full type safety based on the plugin's binding.
   */
  toolCaller: TypedToolCaller<TBinding>;

  /**
   * Organization context.
   * Always available.
   */
  org: PluginOrgContext;

  /**
   * Current user session.
   * Available when user is authenticated.
   */
  session: PluginSession | null;
}

/**
 * Partial plugin context with nullable connection fields.
 * Used by empty state components where no valid connection exists.
 *
 * @template TBinding - The binding type the plugin requires
 *
 * @example
 * ```tsx
 * // In empty state component (no connection)
 * const { session, org } = usePluginContext<typeof REGISTRY_APP_BINDING>({ partial: true });
 *
 * // connection, connectionId, toolCaller are null
 * ```
 */
export interface PluginContextPartial<TBinding extends Binder = Binder> {
  /**
   * The selected connection ID.
   * Null when no valid connection is available.
   */
  connectionId: string | null;

  /**
   * The selected connection entity.
   * Null when no valid connection is available.
   */
  connection: PluginConnectionEntity | null;

  /**
   * Typed tool caller for the selected connection.
   * Null when no valid connection is available.
   */
  toolCaller: TypedToolCaller<TBinding> | null;

  /**
   * Organization context.
   * Always available.
   */
  org: PluginOrgContext;

  /**
   * Current user session.
   * Available when user is authenticated.
   */
  session: PluginSession | null;
}
