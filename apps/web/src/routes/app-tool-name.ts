import { stripMcpServerPrefix } from "@/lib/tool-namespace";

/**
 * Normalize the tool identity consumed by an app view.
 *
 * TanStack Router has already decoded path parameters before they reach the
 * route component. Decoding here again would corrupt literal percent escapes
 * and can throw for otherwise-valid tool names such as `discount%rate`.
 */
export function normalizeAppToolName(toolName: string): string {
  return stripMcpServerPrefix(toolName);
}
