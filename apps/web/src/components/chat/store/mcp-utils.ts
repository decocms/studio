/**
 * Shared MCP-client utilities for the chat stores.
 *
 * Kept narrow on purpose: every export must justify its existence to both
 * `thread-connection.ts` and `thread-manager-store.ts` (or have a clear plan
 * to). If a helper is needed in only one site, leave it inline.
 */

/**
 * Extract a server-side error message from a `callTool` result, falling back
 * to the supplied default when no usable text is present. Mirrors the shape
 * the MCP SDK returns for tool failures: `{ isError: true, content: [{ text }] }`.
 */
export function extractToolErrorMessage(
  result: unknown,
  fallback: string,
): string {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const first = content[0];
    if (first && typeof first === "object") {
      const text = (first as { text?: string }).text;
      if (text) return text;
    }
  }
  return fallback;
}
