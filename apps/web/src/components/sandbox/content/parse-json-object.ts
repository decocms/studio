/**
 * `text` parsed as a JSON object, or null when it is invalid JSON or another
 * JSON value. Kept out of the editor component: React Compiler skips a
 * component with a conditional inside try/catch.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}
