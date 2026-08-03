/**
 * `extractUserText` — pull the most recent user turn's text out of a
 * `ModelMessage[]` for harness-owned title generation.
 *
 * Lives on its own (rather than inside `decopilot/run-stream.ts`, its only
 * caller) because the title path is the one place a harness reads BACK from
 * the prepared prompt, and the empty-content cases below are worth a test.
 */

import type { ModelMessage } from "ai";

/**
 * Pull the user-supplied text out of a prepared ModelMessage[] for
 * harness-owned title generation.
 *
 * Behaviour:
 *  - Walks the array end-to-start, returns the FIRST user message it
 *    sees (i.e. the most recent user turn).
 *  - String content is returned verbatim.
 *  - Array content is filtered to text parts and joined with "\n".
 *  - Anything else (no user message at all, only image/tool-result
 *    parts) returns "". The downstream `genTitle` handles the empty
 *    case via its existing `hasUsableText` guard.
 *
 * Returns a plain string (not JSON-encoded) so `genTitle` sees the
 * user-visible text directly.
 */
export function extractUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const textParts = m.content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" &&
            p !== null &&
            (p as { type?: string }).type === "text",
        )
        .map((p) => p.text);
      return textParts.join("\n");
    }
    return "";
  }
  return "";
}
