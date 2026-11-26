/**
 * The first balanced JSON object in a model's answer, tolerating prose and
 * markdown around it. Null when there is no object at all (a refusal), so the
 * caller can skip it instead of failing on JSON.parse.
 */
export function extractJsonObject(raw: string): string | null {
  const s = raw.replace(/```json?\n?/g, "").replace(/```/g, "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
