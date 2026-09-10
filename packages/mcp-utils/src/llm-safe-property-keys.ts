/**
 * Anthropic rejects the WHOLE request (400 `tools.<i>.custom.input_schema
 * .properties: Property keys should match pattern …`) if any tool's
 * `input_schema.properties` has a key outside this pattern, so one bad MCP tool
 * kills every run. Rename those keys on the way out and map them back on call.
 * Only top-level keys are validated upstream, so only those are touched.
 */
const LLM_SAFE_PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

function sanitizePropertyKey(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
  return safe.length > 0 ? safe : "_";
}

/** Schema with LLM-safe top-level property keys, plus safeKey -> originalKey
 *  for the renamed ones (empty when nothing needed renaming). */
export function llmSafeInputSchema(inputSchema: unknown): {
  schema: unknown;
  keyMap: Map<string, string>;
} {
  const keyMap = new Map<string, string>();
  const properties = (inputSchema as { properties?: unknown } | null)
    ?.properties;
  if (properties == null || typeof properties !== "object") {
    return { schema: inputSchema, keyMap };
  }
  const keys = Object.keys(properties);
  if (keys.every((k) => LLM_SAFE_PROPERTY_KEY.test(k))) {
    return { schema: inputSchema, keyMap };
  }

  const used = new Set(keys.filter((k) => LLM_SAFE_PROPERTY_KEY.test(k)));
  const rename = new Map<string, string>();
  for (const key of keys) {
    if (LLM_SAFE_PROPERTY_KEY.test(key)) continue;
    let safe = sanitizePropertyKey(key);
    if (used.has(safe)) {
      const base = safe.slice(0, 60);
      let i = 2;
      while (used.has(`${base}_${i}`)) i++;
      safe = `${base}_${i}`;
    }
    used.add(safe);
    rename.set(key, safe);
    keyMap.set(safe, key);
  }

  const source = properties as Record<string, unknown>;
  const renamedProperties: Record<string, unknown> = {};
  for (const key of keys) {
    renamedProperties[rename.get(key) ?? key] = source[key];
  }
  const original = inputSchema as Record<string, unknown>;
  const schema: Record<string, unknown> = {
    ...original,
    properties: renamedProperties,
  };
  if (Array.isArray(original.required)) {
    schema.required = original.required.map((k) =>
      typeof k === "string" ? (rename.get(k) ?? k) : k,
    );
  }
  return { schema, keyMap };
}

/** Undo `llmSafeInputSchema`'s renaming on a tool call's arguments. */
export function restoreOriginalKeys(
  input: Record<string, unknown>,
  keyMap: Map<string, string>,
): Record<string, unknown> {
  if (keyMap.size === 0) return input;
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    restored[keyMap.get(key) ?? key] = value;
  }
  return restored;
}
