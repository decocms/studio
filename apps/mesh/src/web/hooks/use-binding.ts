import { z } from "zod";
import { type Binder, createBindingChecker } from "@decocms/bindings";
import {
  BaseCollectionEntitySchema,
  createCollectionBindings,
} from "@decocms/bindings/collections";
import { ASSISTANTS_BINDING } from "@decocms/bindings/assistant";
import { LANGUAGE_MODEL_BINDING } from "@decocms/bindings/llm";
import { MCP_BINDING } from "@decocms/bindings/mcp";
import { convertJsonSchemaToZod } from "zod-from-json-schema";
import type { ConnectionEntity } from "@/tools/connection/schema";
import {
  WORKFLOW_BINDING,
  WORKFLOW_EXECUTION_BINDING,
} from "@decocms/bindings/workflow";

/**
 * Map of well-known binding names to their definitions
 */
const BUILTIN_BINDINGS: Record<string, Binder> = {
  LLMS: LANGUAGE_MODEL_BINDING,
  WORKFLOW: WORKFLOW_BINDING,
  WORKFLOW_EXECUTION: WORKFLOW_EXECUTION_BINDING,
  ASSISTANTS: ASSISTANTS_BINDING,
  MCP: MCP_BINDING,
};

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
 * Formats a collection name for display
 * e.g., "LLM" -> "Llm", "USER_PROFILES" -> "User Profiles"
 */
function formatCollectionName(name: string): string {
  return name
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
 * Extracts collection schema from tools
 */
function extractCollectionSchema(
  tools: Array<{
    name: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>,
  collectionName: string,
): Record<string, unknown> | undefined {
  // Try to get schema from CREATE tool (preferred as it has full entity)
  const createTool = tools.find(
    (t) => t.name === `COLLECTION_${collectionName}_CREATE`,
  );
  const createToolProperties = createTool?.inputSchema?.properties;
  if (
    createToolProperties &&
    typeof createToolProperties === "object" &&
    "data" in createToolProperties
  ) {
    return createToolProperties.data as Record<string, unknown>;
  }

  // Try to get schema from UPDATE tool
  const updateTool = tools.find(
    (t) => t.name === `COLLECTION_${collectionName}_UPDATE`,
  );
  const updateToolProperties = updateTool?.inputSchema?.properties;
  if (
    updateToolProperties &&
    typeof updateToolProperties === "object" &&
    "data" in updateToolProperties
  ) {
    // Update usually has partial data, but might still be useful
    return updateToolProperties.data as Record<string, unknown>;
  }

  // Try to get schema from LIST tool (output)
  const listTool = tools.find(
    (t) => t.name === `COLLECTION_${collectionName}_LIST`,
  );
  const listToolProperties = listTool?.outputSchema?.properties;
  if (
    listToolProperties &&
    typeof listToolProperties === "object" &&
    "items" in listToolProperties
  ) {
    const itemsSchema = listToolProperties.items as Record<string, unknown>;
    if (itemsSchema.items) {
      return itemsSchema.items as Record<string, unknown>;
    }
  }

  return undefined;
}

/**
 * Detects CRUD capabilities for a collection
 */
function detectCrudCapabilities(
  tools: Array<{ name: string }>,
  collectionName: string,
): {
  hasCreateTool: boolean;
  hasUpdateTool: boolean;
  hasDeleteTool: boolean;
} {
  const upperCollectionName = collectionName.toUpperCase();
  return {
    hasCreateTool: tools.some(
      (t) => t.name === `COLLECTION_${upperCollectionName}_CREATE`,
    ),
    hasUpdateTool: tools.some(
      (t) => t.name === `COLLECTION_${upperCollectionName}_UPDATE`,
    ),
    hasDeleteTool: tools.some(
      (t) => t.name === `COLLECTION_${upperCollectionName}_DELETE`,
    ),
  };
}

/**
 * Detects and validates collection bindings from tools
 */
function detectCollections(
  tools: Array<{
    name: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }> | null,
): ValidatedCollection[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const potentialCollections = extractCollectionNames(tools);

  if (potentialCollections.length === 0) {
    return [];
  }

  const validatedCollections: ValidatedCollection[] = [];

  for (const collectionName of potentialCollections) {
    try {
      // Create a minimal collection binding to check against (read-only)
      const binding = createCollectionBindings(
        collectionName.toLowerCase(),
        BaseCollectionEntitySchema,
        { readOnly: true },
      );

      // For collection detection, we only validate input schema compatibility.
      // Output schema validation is skipped because:
      // 1. The binding uses BaseCollectionEntitySchema with minimal required fields
      // 2. Actual collections have additional required fields (description, instructions, etc.)
      // 3. json-schema-diff sees extra required fields as "removals" (stricter schema)
      const toolsForChecker = tools.map((t) => ({
        name: t.name,
        inputSchema: t.inputSchema,
        // outputSchema intentionally omitted for detection
      }));

      // Create binding without output schemas for the same reason
      const bindingForChecker = binding.map((b) => ({
        name: b.name,
        inputSchema: b.inputSchema,
      }));

      const checker = createBindingChecker(bindingForChecker);
      const isValid = checker.isImplementedBy(toolsForChecker);

      if (isValid) {
        const crudCapabilities = detectCrudCapabilities(tools, collectionName);
        validatedCollections.push({
          name: collectionName,
          displayName: formatCollectionName(collectionName),
          schema: extractCollectionSchema(tools, collectionName),
          ...crudCapabilities,
        });
      }
    } catch {
      // Skip collections that fail validation
    }
  }

  return validatedCollections;
}

/**
 * Hook to detect and validate collection bindings from connection tools
 * Runs entirely client-side using the connection's tools array
 *
 * @param connection - The connection entity to analyze
 * @returns Array of validated collections
 */
export function useCollectionBindings(
  connection: ConnectionEntity | undefined,
): ValidatedCollection[] {
  return detectCollections(connection?.tools ?? null);
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
        // Any connection exposing REGISTRY_APP collection tools can act as a store registry.
        // This includes the org self MCP when private-registry tools are enabled.
        return (
          extractCollectionNames(conn.tools).includes("REGISTRY_APP") ||
          hasRegistryListTool(conn.tools)
        );
      });
}
