import type { ToolInputProperty } from "@/components/tool-input-form";

/** Coerce form values for persistence: JSON-parse object/array fields,
 * convert number/integer strings. Returns null on parse error (caller
 * should toast). */
export function coerceFormValues(
  values: Record<string, unknown>,
  properties: Record<string, ToolInputProperty>,
  required?: string[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const type = properties[key]?.type;
    if ((type === "object" || type === "array") && typeof raw === "string") {
      if (!raw.trim()) continue;
      try {
        out[key] = JSON.parse(raw);
      } catch {
        return null;
      }
    } else if (
      (type === "number" || type === "integer") &&
      (typeof raw === "string" || typeof raw === "number")
    ) {
      if (typeof raw === "string" && !raw.trim()) continue;
      const parsed = typeof raw === "string" ? Number(raw) : raw;
      if (!Number.isFinite(parsed)) return null;
      if (type === "integer" && !Number.isInteger(parsed)) return null;
      out[key] = parsed;
    } else if (typeof raw === "string") {
      if (!raw.trim()) continue;
      out[key] = raw;
    } else if (raw != null) {
      out[key] = raw;
    }
  }
  if (required?.some((key) => !(key in out))) return null;
  return out;
}

/** Stringify toolInput values for form display: object/array values become
 * JSON strings so they render in a Textarea. */
export function seedFormValues(
  toolInput: Record<string, unknown> | undefined,
  properties: Record<string, ToolInputProperty> | undefined,
): Record<string, unknown> {
  if (!toolInput || !properties) return {};
  const init: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(toolInput)) {
    const type = properties[key]?.type;
    if (
      (type === "object" || type === "array") &&
      val != null &&
      typeof val !== "string"
    ) {
      init[key] = JSON.stringify(val, null, 2);
    } else {
      init[key] = val;
    }
  }
  return init;
}

/** Summarize toolInput for display in the pinned tile row. */
export function toolInputSummary(
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return "";
  const entries = Object.entries(toolInput).filter(
    ([, v]) => v != null && v !== "",
  );
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}=${s.length > 20 ? `${s.slice(0, 20)}…` : s}`;
    })
    .join(", ");
}
