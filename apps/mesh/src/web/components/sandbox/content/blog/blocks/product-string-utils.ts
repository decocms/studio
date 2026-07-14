/** Read a canonical `platform:kind:id` product reference from block props. */
export function readStringRef(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read a list of canonical product references from block props. */
export function readStringRefList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item : ""));
}
