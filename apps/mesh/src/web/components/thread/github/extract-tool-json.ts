/**
 * Normalizes the two shapes github-mcp-server returns tool results in:
 *   - `structuredContent: T` (parsed JSON, preferred)
 *   - `content: [{ type: "text", text: "<stringified JSON>" }]` (fallback)
 *
 * Returns null when the result is missing, the text is not valid JSON, or
 * the input is null/undefined. Callers are expected to type-assert the
 * generic `T`; no runtime schema validation happens here.
 */
type ToolResultLike = {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

export function extractToolJson<T>(r: unknown): T | null {
  if (!r || typeof r !== "object") return null;
  const result = r as ToolResultLike;
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const textPart = result.content?.find((c) => c.type === "text")?.text;
  if (!textPart) return null;
  try {
    return JSON.parse(textPart) as T;
  } catch {
    return null;
  }
}
