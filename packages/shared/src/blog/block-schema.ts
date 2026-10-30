/**
 * A block's JSON Schema, as the thing that writes into it needs to see it.
 *
 * Read from the meta document rather than through the editor's resolver: the
 * editor resolves for a form, which means following every `$ref` it can. Here
 * the budget is a prompt, so depth and size are capped and the plumbing props
 * a writer must not set are cut.
 */
import type { LiveMeta } from "./live-meta";

/**
 * The `required` names this schema still declares a property for.
 *
 * deco wraps a block's config as `{ properties: {__resolveType}, required:
 * ["__resolveType"], allOf: [{$ref: Props}] }`, and `resolveSchema` drops every
 * `__`-prefixed key from `properties` while keeping `required` whole. What
 * comes out demands a property it does not declare — and `__resolveType` is the
 * one thing the writer is never shown, so every section it wrote failed
 * validation on a field it could not have known to write.
 */
function requiredOf(
  source: Record<string, unknown>,
  properties: unknown,
): string[] | undefined {
  const names = source.required;
  if (!Array.isArray(names)) return undefined;
  const declared = new Set(
    properties && typeof properties === "object"
      ? Object.keys(properties as Record<string, unknown>)
      : [],
  );
  const kept = names.filter(
    (name): name is string => typeof name === "string" && declared.has(name),
  );
  return kept.length > 0 ? kept : undefined;
}

/** How deep a `$ref` chain is followed before a branch is left unresolved. */
const MAX_SCHEMA_DEPTH = 6;

/** How much of one block's schema travels. A `Product` ref expands forever. */
const MAX_BLOCK_SCHEMA_CHARS = 6_000;

function definitionsOf(meta: LiveMeta): Record<string, unknown> {
  const schema = (meta.schema ?? {}) as Record<string, unknown>;
  const defs = schema.$defs ?? schema.definitions;
  return defs && typeof defs === "object"
    ? (defs as Record<string, unknown>)
    : {};
}

function manifestEntry(resolveType: string, meta: LiveMeta): unknown {
  for (const group of Object.values(meta.manifest?.blocks ?? {})) {
    const entry = (group as Record<string, unknown>)[resolveType];
    if (entry) return entry;
  }
  return undefined;
}

/** Follow `$ref` through the live meta's own definitions, bounded. */
function deref(
  node: unknown,
  defs: Record<string, unknown>,
  depth: number,
): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => deref(entry, defs, depth));
  }
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;

  if (typeof record.$ref === "string") {
    if (depth >= MAX_SCHEMA_DEPTH) return {};
    const key = record.$ref.split("/").pop() ?? "";
    const target = defs[key];
    if (target === undefined) return {};
    return deref(target, defs, depth + 1);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = deref(value, defs, depth);
  }
  return out;
}

/**
 * A block's own JSON Schema, read from the live meta rather than rebuilt.
 *
 * `resolveSchema` is the editor's view: it exists to render a form, so it
 * flattens what a form cannot show. A `string | string[]` prop comes out of it
 * typed `object` — and a writer handed that writes an object, which is how a
 * list the site stores as one newline-joined string came back as a map.
 *
 * The meta carries the real thing. deco wraps a block as
 * `{ allOf: [{$ref: Props}], properties: {__resolveType}, required: [...] }`,
 * so the props schema is one hop in: its `anyOf`, its `format`, its `options`
 * loader and its descriptions all survive, which is everything the writer
 * needs and none of what the form needed.
 */
export function rawBlockSchema(
  resolveType: string,
  meta: LiveMeta,
): Record<string, unknown> {
  const defs = definitionsOf(meta);
  const wrapper = deref(manifestEntry(resolveType, meta), defs, 0);
  if (!wrapper || typeof wrapper !== "object") return {};

  const record = wrapper as Record<string, unknown>;
  const allOf = record.allOf;
  const props = Array.isArray(allOf) && allOf.length === 1 ? allOf[0] : record;
  if (!props || typeof props !== "object") return {};

  const { $schema: _schema, ...rest } = props as Record<string, unknown>;
  const trimmed = withoutPlumbing(rest);
  return JSON.stringify(trimmed).length > MAX_BLOCK_SCHEMA_CHARS
    ? withoutPlumbing(rest, true)
    : trimmed;
}

/** `__resolveType` is the caller's to stamp, so it never reaches the writer. */
function withoutPlumbing(
  schema: Record<string, unknown>,
  shallow = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  const properties = out.properties;
  if (properties && typeof properties === "object") {
    const kept = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>)
        .filter(([name]) => !name.startsWith("__"))
        .map(([name, value]) => [name, shallow ? shallowProp(value) : value]),
    );
    out.properties = kept;
    out.required = requiredOf(out, kept);
    if (!out.required) delete out.required;
  }
  return out;
}

/** A prop stripped to what it is, for a schema too big to send whole. */
function shallowProp(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const prop = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ["type", "description", "format", "options", "enum"]) {
    if (key in prop) kept[key] = prop[key];
  }
  if (Array.isArray(prop.anyOf)) kept.anyOf = prop.anyOf.map(shallowProp);
  return kept;
}

/** The JSON type of a stored value, as a schema would name it. */
function jsonType(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  return t === "number" || t === "boolean" || t === "string" || t === "object"
    ? t
    : null;
}

/**
 * The schema, with the assertions a real block disproves taken out.
 *
 * Both halves are evidence and they do not always agree: a `List` whose `$ref`
 * did not resolve is typed `object` by `resolveSchema`'s last-resort branch,
 * while every one the site renders stores a newline-joined string. Telling the
 * writer to follow the example and then validating against the schema is a
 * contradiction that costs the section either way.
 *
 * So a stored block wins on its own properties: where the two disagree, the
 * schema's `type` and `enum` for that property come out and the rest stays. It
 * is narrow on purpose — the example disproves what it covers, nothing more.
 */
export function reconciledSchema(
  schema: Record<string, unknown>,
  example: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!example || !properties || typeof properties !== "object") return schema;

  const source = properties as Record<string, unknown>;
  let changed = false;
  const reconciled: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(source)) {
    const prop = raw && typeof raw === "object" ? { ...raw } : raw;
    const declared = (prop as Record<string, unknown> | null)?.type;
    const stored = jsonType(example[name]);
    if (
      prop &&
      typeof prop === "object" &&
      stored &&
      typeof declared === "string" &&
      declared !== stored
    ) {
      delete (prop as Record<string, unknown>).type;
      delete (prop as Record<string, unknown>).enum;
      changed = true;
    }
    reconciled[name] = prop;
  }
  return changed ? { ...schema, properties: reconciled } : schema;
}
