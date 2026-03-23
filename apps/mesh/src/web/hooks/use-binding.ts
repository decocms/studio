import { z } from "zod";
import { type Binder, createBindingChecker } from "@decocms/bindings";
import { ASSISTANTS_BINDING } from "@decocms/bindings/assistant";
import { LANGUAGE_MODEL_BINDING } from "@decocms/bindings/llm";
import { MCP_BINDING } from "@decocms/bindings/mcp";
import { EVENT_BUS_BINDING, TRIGGER_BINDING } from "@decocms/bindings";
import { convertJsonSchemaToZod } from "zod-from-json-schema";
import type { ConnectionEntity } from "@/tools/connection/schema";
import {
  WORKFLOW_BINDING,
  WORKFLOW_EXECUTION_BINDING,
} from "@decocms/bindings/workflow";
import { AI_GATEWAY_BILLING_BINDING } from "@decocms/bindings/ai-gateway";

/**
 * Map of well-known binding names to their Binder definitions.
 * Used by useBindingConnections to filter connections by tool capabilities.
 */
const BUILTIN_BINDINGS: Record<string, Binder> = {
  LLMS: LANGUAGE_MODEL_BINDING,
  WORKFLOW: WORKFLOW_BINDING,
  WORKFLOW_EXECUTION: WORKFLOW_EXECUTION_BINDING,
  ASSISTANTS: ASSISTANTS_BINDING,
  MCP: MCP_BINDING,
  AI_GATEWAY_BILLING: AI_GATEWAY_BILLING_BINDING,
  EVENT_BUS: EVENT_BUS_BINDING,
  TRIGGER: TRIGGER_BINDING,
};

/**
 * Maps `@deco/` binding type identifiers (from MCP_CONFIGURATION stateSchema `__type.const`)
 * to BUILTIN_BINDINGS keys.
 *
 * When a binding field declares `__type: "@deco/event-bus"`, we resolve it to the
 * builtin "EVENT_BUS" binding and match connections by their tools instead of
 * falling back to app-name matching (which doesn't work for built-in bindings
 * like the Mesh MCP).
 */
const BINDING_TYPE_TO_BUILTIN: Record<string, string> = {
  "@deco/event-bus": "EVENT_BUS",
  "@deco/llm": "LLMS",
  "@deco/trigger": "TRIGGER",
};

/**
 * Resolves a `@deco/` binding type identifier to a builtin binding name.
 * Returns undefined if the type is not a well-known builtin.
 *
 * @example
 * resolveBindingType("@deco/event-bus") // "EVENT_BUS"
 * resolveBindingType("@deco/llm")       // "LLMS"
 * resolveBindingType("@deco/unknown")   // undefined
 */
export function resolveBindingType(
  bindingType: string | undefined,
): string | undefined {
  if (!bindingType) return undefined;
  return BINDING_TYPE_TO_BUILTIN[bindingType];
}

/**
 * Simplified binding definition format (JSON Schema based)
 */
export interface BindingDefinition {
  /** Tool name to match (e.g., "MY_TOOL", "COLLECTION_USERS_LIST") */
  name: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for the tool's output */
  outputSchema?: Record<string, unknown>;
}

/**
 * Converts a simplified binding definition to Binder format
 */
function convertBindingToBinder(bindings: BindingDefinition[]): Binder {
  return bindings.map((binding) => ({
    name: binding.name,
    inputSchema: binding.inputSchema
      ? (() => {
          try {
            return convertJsonSchemaToZod(binding.inputSchema);
          } catch (error) {
            console.error(
              `Failed to convert input schema for ${binding.name}:`,
              error,
            );
            return z.object({});
          }
        })()
      : z.object({}),
    outputSchema: binding.outputSchema
      ? (() => {
          try {
            return convertJsonSchemaToZod(
              binding.outputSchema,
            ) as unknown as z.ZodType<object>;
          } catch (error) {
            console.error(
              `Failed to convert output schema for ${binding.name}:`,
              error,
            );
            return z.object({});
          }
        })()
      : z.object({}),
  }));
}

/**
 * Checks if a connection implements a binding by validating its tools
 */
export function connectionImplementsBinding(
  connection: ConnectionEntity,
  binding: Binder,
): boolean {
  const tools = connection.tools;

  if (!tools || tools.length === 0) {
    return false;
  }

  // Prepare tools for checker (only input schema, skip output for detection)
  const toolsForChecker = tools.map((t) => ({
    name: t.name,
    inputSchema: t.inputSchema as Record<string, unknown> | undefined,
  }));

  // Create binding checker without output schemas
  const bindingForChecker = binding.map((b) => ({
    name: b.name,
    inputSchema: b.inputSchema,
    opt: b.opt,
  }));

  const checker = createBindingChecker(bindingForChecker);
  return checker.isImplementedBy(toolsForChecker);
}

/**
 * Options for useBindingConnections hook
 */
interface UseBindingConnectionsOptions {
  connections: ConnectionEntity[] | undefined;
  /**
   * Binding filter - can be:
   * - A well-known binding name (e.g., "LLMS", "AGENTS", "MCP")
   * - A custom binding schema array (BindingDefinition[]) for filtering connections
   */
  binding?: string | BindingDefinition[];
}

/**
 * Hook to filter connections that implement a specific binding.
 * Returns only connections whose tools satisfy the binding requirements.
 *
 * @param options - Object with connections and binding
 * @returns Filtered array of connections that implement the binding
 *
 * @example
 * // Using well-known binding name
 * useBindingConnections({ connections: allConnections, binding: "LLMS" })
 *
 * @example
 * // Using custom binding schema
 * useBindingConnections({ connections: allConnections, binding: [{ name: "MY_TOOL", inputSchema: {...} }] })
 */
export function useBindingConnections({
  connections,
  binding,
}: UseBindingConnectionsOptions): ConnectionEntity[] {
  // Resolve binding definition:
  // - If binding is a string, look up in BUILTIN_BINDINGS
  // - If binding is an array, convert JSON schemas to Binder
  const resolvedBinding = (() => {
    if (!binding) {
      return undefined;
    }
    if (typeof binding === "string") {
      const upperBinding = binding.toUpperCase();
      const builtinBinding = BUILTIN_BINDINGS[upperBinding];

      if (!builtinBinding) {
        console.warn(
          `[useBindingConnections] Unknown binding "${binding}". ` +
            `Available bindings: ${Object.keys(BUILTIN_BINDINGS).join(", ")}. ` +
            `Returning all connections without filtering.`,
        );
        return undefined;
      }

      return builtinBinding;
    }

    // Validate binding array
    if (binding.length === 0) {
      console.warn(
        "[useBindingConnections] Empty binding array provided. " +
          "Returning all connections without filtering.",
      );
      return undefined;
    }

    return convertBindingToBinder(binding);
  })();

  if (!connections) {
    return [];
  }

  // If no binding filter, return all connections
  if (!resolvedBinding) {
    return connections;
  }

  // Filter connections by binding
  return connections.filter((conn) =>
    connectionImplementsBinding(conn, resolvedBinding),
  );
}

/**
 * Validated collection binding
 */
export interface ValidatedCollection {
  name: string;
  displayName: string;
  schema?: Record<string, unknown>;
  hasCreateTool: boolean;
  hasUpdateTool: boolean;
  hasDeleteTool: boolean;
}

/**
 * Extracts collection names from tools using regex pattern
 * Matches COLLECTION_{NAME}_LIST where NAME can contain underscores
 */
function extractCollectionNames(
  tools: Array<{ name: string }> | null | undefined,
): string[] {
  if (!tools || tools.length === 0) return [];

  const collectionRegex = /^COLLECTION_(.+)_LIST$/;
  const names: string[] = [];

  for (const tool of tools) {
    const match = tool.name.match(collectionRegex);
    if (match?.[1]) {
      names.push(match[1]);
    }
  }

  return names;
}

function hasRegistryListTool(
  tools: Array<{ name: string }> | null | undefined,
): boolean {
  if (!tools || tools.length === 0) return false;
  return tools.some((tool) => {
    if (tool.name === "REGISTRY_ITEM_LIST") return true;
    if (tool.name === "COLLECTION_REGISTRY_APP_LIST") return true;
    return tool.name.startsWith("COLLECTION_REGISTRY_APP_");
  });
}

/**
 * Hook to filter connections that have registry/store capabilities
 * Returns only connections that expose collections
 *
 * @param connections - Array of connections to filter
 * @returns Filtered array of connections that have collections (registries)
 */
export function useRegistryConnections(
  connections: ConnectionEntity[] | undefined,
): ConnectionEntity[] {
  return !connections
    ? []
    : connections.filter((conn) => {
        // Fast path: check metadata flag set at create/update time
        const meta = conn.metadata as Record<string, unknown> | null;
        if (meta?.is_registry === true) return true;

        // Fallback: check tools for connections that haven't been re-saved yet
        return (
          extractCollectionNames(conn.tools).includes("REGISTRY_APP") ||
          hasRegistryListTool(conn.tools)
        );
      });
}
