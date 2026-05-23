/**
 * Safely parse a JSON value that may be a string (from DB) or already parsed
 * (some pg drivers auto-parse `json` / `jsonb` columns). Returns null for
 * null/undefined input. Falls through silently if the string isn't valid JSON.
 */
export function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
