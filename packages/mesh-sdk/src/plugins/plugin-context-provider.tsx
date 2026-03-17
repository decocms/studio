/**
 * Plugin Context Provider
 *
 * React context provider and hook for accessing plugin context.
 * Moved from @decocms/bindings to @decocms/mesh-sdk to consolidate
 * all plugin-facing React components in one package.
 */

import { createContext, useContext, type ReactNode } from "react";
import type {
  Binder,
  PluginContext,
  PluginContextPartial,
} from "@decocms/bindings";

// Internal context stores the partial version (nullable connection fields)
// The hook return type depends on the options passed
const PluginContextInternal = createContext<PluginContextPartial | null>(null);

export interface PluginContextProviderProps<TBinding extends Binder> {
  value: PluginContext<TBinding> | PluginContextPartial<TBinding>;
  children: ReactNode;
}

/**
 * Provider component for plugin context.
 * Used by the mesh app layout to provide context to plugin routes.
 */
export function PluginContextProvider<TBinding extends Binder>({
  value,
  children,
}: PluginContextProviderProps<TBinding>) {
  return (
    <PluginContextInternal.Provider value={value as PluginContextPartial}>
      {children}
    </PluginContextInternal.Provider>
  );
}

/**
 * Options for usePluginContext hook.
 */
export interface UsePluginContextOptions {
  /**
   * Set to true when calling from an empty state component.
   * This returns nullable connection fields since no valid connection exists.
   */
  partial?: boolean;
}

/**
 * Hook to access the plugin context with typed tool caller.
 *
 * @template TBinding - The binding type for typed tool calls
 * @param options - Optional settings
 * @param options.partial - Set to true in empty state components where connection may not exist
 * @throws Error if used outside of PluginContextProvider
 * @throws Error if connection is null but partial option is not set
 *
 * @example
 * ```tsx
 * // In route component (connection guaranteed by layout)
 * const { toolCaller, connection } = usePluginContext<typeof REGISTRY_APP_BINDING>();
 * const result = await toolCaller("REGISTRY_LIST", { limit: 20 });
 *
 * // In empty state component (no connection available)
 * const { session, org } = usePluginContext<typeof REGISTRY_APP_BINDING>({ partial: true });
 * ```
 */
export function usePluginContext<TBinding extends Binder = Binder>(options: {
  partial: true;
}): PluginContextPartial<TBinding>;
export function usePluginContext<
  TBinding extends Binder = Binder,
>(): PluginContext<TBinding>;
export function usePluginContext<TBinding extends Binder = Binder>(
  options?: UsePluginContextOptions,
): PluginContext<TBinding> | PluginContextPartial<TBinding> {
  const context = useContext(PluginContextInternal);
  if (!context) {
    throw new Error(
      "usePluginContext must be used within a PluginContextProvider",
    );
  }

  // If partial mode, return as-is with nullable fields
  if (options?.partial) {
    return context as PluginContextPartial<TBinding>;
  }

  // Otherwise, assert that connection exists (routes should always have one)
  if (!context.connectionId || !context.connection || !context.toolCaller) {
    throw new Error(
      "usePluginContext requires a valid connection. Use { partial: true } in empty state components.",
    );
  }

  return context as PluginContext<TBinding>;
}
