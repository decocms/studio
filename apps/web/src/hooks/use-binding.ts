import { type Binder, createBindingChecker } from "@decocms/bindings";
import type { ConnectionEntity } from "@decocms/shared/sdk/types";

/**
 * Maps `@deco/` binding type identifiers (from MCP_CONFIGURATION stateSchema `__type.const`)
 * to BUILTIN_BINDINGS keys.
 *
 * When a binding field declares `__type: "@deco/llm"`, we resolve it to the
 * builtin "LLMS" binding and match connections by their tools instead of
 * falling back to app-name matching (which doesn't work for built-in bindings
 * like Studio's self-management MCP).
 */
const BINDING_TYPE_TO_BUILTIN: Record<string, string> = {
  "@deco/llm": "LLMS",
  "@deco/trigger": "TRIGGER",
  "@deco/object-storage": "OBJECT_STORAGE",
  "@deco/brand": "BRAND",
};

/**
 * Resolves a `@deco/` binding type identifier to a builtin binding name.
 * Returns undefined if the type is not a well-known builtin.
 *
 * @example
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
