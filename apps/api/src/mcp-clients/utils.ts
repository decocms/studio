import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Creates an error handler that returns a fallback result when encountering
 * MethodNotFound errors, otherwise re-throws the error.
 *
 * This is useful for gracefully handling MCP servers that don't support
 * certain methods (resources, prompts, etc.).
 *
 * @param fallbackResult - The fallback result object to return (e.g., { resources: [] } or { prompts: [] })
 * @returns An error handler function that can be used in .catch() chains
 *
 * @example
 * ```ts
 * const emptyResources = fallbackOnMethodNotFoundError({ resources: [] });
 * await client.listResources().catch(emptyResources);
 * ```
 */
export function fallbackOnMethodNotFoundError<T>(
  fallbackResult: T,
): (error: unknown) => T {
  return (error: unknown): T => {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
      return fallbackResult;
    }
    throw error;
  };
}
