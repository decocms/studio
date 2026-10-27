/**
 * A generated section's props, checked against the block that will render them.
 *
 * Generation used to emit a flat object of seven optional fields and the caller
 * wrote each kind out by hand. That worked only for the blocks the blog app
 * ships: a site overriding `Callout` with its own props got its resolveType
 * matched by name and its props filled from assumptions, which saves without
 * error and renders empty.
 *
 * So the block's own JSON Schema travels with it, and this is what makes it
 * binding. Props arrive as a JSON string rather than an object — a schema the
 * model fills freely becomes `additionalProperties` in structured output, which
 * is the kind of thing that works on three providers and fails on the fourth,
 * and the validation here is the real guarantee either way.
 */

import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";
import {
  clearSentinels,
  IMAGE_SENTINEL,
  sentinelRequests,
} from "@decocms/shared/blog-image-sentinel";

export { clearSentinels, IMAGE_SENTINEL, sentinelRequests };

/** Deco's marker for a prop holding an image address. */
const IMAGE_FORMAT = "image-uri";

type Schema = Record<string, unknown>;

export interface BlockDef {
  name: string;
  title: string;
  description: string;
  schema: Schema;
}

function asSchema(value: unknown): Schema | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : null;
}

function propertiesOf(schema: Schema): Record<string, Schema> {
  const props = asSchema(schema.properties);
  if (!props) return {};
  const out: Record<string, Schema> = {};
  for (const [key, value] of Object.entries(props)) {
    const child = asSchema(value);
    if (child) out[key] = child;
  }
  return out;
}

/**
 * Props the block does not declare, removed.
 *
 * A model writing a plausible-looking extra field is the common case, and ajv
 * would reject the whole section for it. Pruning first means one invented prop
 * costs that prop rather than the paragraph it was attached to.
 *
 * Only descends where the shape is unambiguous — an object with `properties`,
 * or an array whose `items` is one such object. A branch under `anyOf`/`oneOf`
 * is left whole, because which branch applies is ajv's call, not ours.
 */
export function pruneProps(value: unknown, schema: Schema): unknown {
  if (schema.anyOf || schema.oneOf || schema.allOf) return value;

  const items = asSchema(schema.items);
  if (Array.isArray(value) && items) {
    return value.map((entry) => pruneProps(entry, items));
  }

  const record = asSchema(value);
  if (!record) return value;
  const properties = propertiesOf(schema);
  if (Object.keys(properties).length === 0) return value;

  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(properties)) {
    if (key in record) kept[key] = pruneProps(record[key], child);
  }
  return kept;
}

/** Either the props a block can render, or why it cannot. */
export type PropsRead =
  | { props: Schema; reason?: undefined }
  | { props?: undefined; reason: string };

/**
 * One section's props, or why the block cannot render them.
 *
 * Dropping beats repairing: a section missing a required prop renders empty,
 * and a shorter post is better than a gap in the middle of one. But a drop with
 * no reason attached is how a whole post comes back empty and nobody can say
 * which of three causes it was, so the reason travels to the log.
 */
export function readProps(
  raw: string,
  schema: Schema,
  example?: Schema,
): PropsRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { reason: `props are not JSON: ${message(err)}` };
  }
  const pruned = pruneProps(parsed, schema);
  const asObject = asSchema(pruned);
  if (!asObject) return { reason: "props are not an object" };
  const record = asStored(asObject, example);
  try {
    const { valid, errorMessage } = sharedJsonSchemaValidator.getValidator(
      forValidation(schema),
    )(record);
    return valid ? { props: record } : { reason: errorMessage };
  } catch (err) {
    // ajv can throw compiling a malformed block schema (e.g. a bad regex `pattern`).
    return { reason: `block schema could not be compiled: ${message(err)}` };
  }
}

/** How this site keeps a list in one value: `a\nb\nc`. */
const ITEM_SEPARATOR = "\n";

/**
 * The props in the shape this site stores, where both shapes hold the same thing.
 *
 * A prop declared `string | string[]` is valid either way, so a schema cannot
 * settle it and the writer picks one — and it picks the one the schema lists
 * first as often as not. The site has already settled it: whatever a block it
 * renders holds is what its section reads back.
 *
 * Which string, though, is the site's call too. A `List` joins its items with
 * newlines; `Checklist`, `Table`, `Steps` and the rest carry JSON inside the
 * string, and newline-joining one of those is worse than leaving it an array —
 * it validates as a string and then renders empty, because the block parses it
 * and gets nothing. So the stored value says which encoding it is.
 *
 * Only where the two disagree, and only where the stored form is unambiguous.
 */
function asStored(props: Schema, example: Schema | undefined): Schema {
  if (!example) return props;
  const out: Schema = { ...props };
  for (const [key, stored] of Object.entries(example)) {
    const value = out[key];
    if (typeof stored === "string" && isComposite(value)) {
      if (isJsonText(stored)) out[key] = JSON.stringify(value);
      else if (isStringList(value)) out[key] = value.join(ITEM_SEPARATOR);
      continue;
    }
    if (isStringList(stored) && typeof value === "string") {
      const decoded = jsonValue(value);
      out[key] = Array.isArray(decoded)
        ? decoded
        : value.split(ITEM_SEPARATOR).filter((entry) => entry.trim());
    }
  }
  return out;
}

/** An array or an object — the two a site may keep encoded in a string. */
function isComposite(value: unknown): boolean {
  return !!value && typeof value === "object";
}

/** True when the stored string is itself JSON, so the site encodes rather than joins. */
function isJsonText(text: string): boolean {
  return jsonValue(text) !== null;
}

/** What this text decodes to, or null when it is not JSON at all. */
function jsonValue(text: string): unknown[] | Schema | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    return asSchema(parsed);
  } catch {
    return null;
  }
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  );
}

/** One stripped copy per schema, so the validator cache still hits by identity. */
const validationSchemas = new WeakMap<Schema, Schema>();

/**
 * The schema with its widget hints taken out, for the validator alone.
 *
 * deco's `@format` picks an editor control — `textarea`, `dynamic-options`,
 * `image-uri` — not a value constraint. ajv has never heard of them, ignores
 * them, and says so once per compile, which is a line in the log for every
 * block on every run and a red herring every time someone reads it.
 *
 * Only the copy ajv sees loses them. The prompt keeps `format`, because it is
 * how the writer learns a field is loader-driven, and {@link imageRequests}
 * reads it to find where an image was asked for.
 */
function forValidation(schema: Schema): Schema {
  const cached = validationSchemas.get(schema);
  if (cached) return cached;
  const stripped = withoutFormats(schema) as Schema;
  validationSchemas.set(schema, stripped);
  return stripped;
}

function withoutFormats(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutFormats);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Schema)) {
    if (key === "format") continue;
    out[key] = withoutFormats(value);
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One image the model asked to have generated, and where it goes. */
export interface ImageRequest {
  path: (string | number)[];
  prompt: string;
}

/**
 * Where this block wants an image, and what of.
 *
 * Driven by the schema rather than by a list of block names, so a site's own
 * section with an `ImageWidget` prop works the day it is written. The sentinel
 * is what separates "generate this" from an address the model copied out of the
 * store's catalogue, which must be left exactly as it is.
 */
export function imageRequests(
  value: unknown,
  schema: Schema,
  path: (string | number)[] = [],
): ImageRequest[] {
  if (typeof value === "string") {
    const wanted =
      schema.type === "string" &&
      schema.format === IMAGE_FORMAT &&
      value.startsWith(IMAGE_SENTINEL);
    if (!wanted) return [];
    const prompt = value.slice(IMAGE_SENTINEL.length).trim();
    return prompt ? [{ path, prompt }] : [];
  }

  const items = asSchema(schema.items);
  if (Array.isArray(value) && items) {
    return value.flatMap((entry, i) =>
      imageRequests(entry, items, [...path, i]),
    );
  }

  const record = asSchema(value);
  if (!record) return [];
  return Object.entries(propertiesOf(schema)).flatMap(([key, child]) =>
    key in record ? imageRequests(record[key], child, [...path, key]) : [],
  );
}

/** The props with one image address written in, leaving the rest untouched. */
export function withImageAt(
  props: Schema,
  path: (string | number)[],
  url: string,
): Schema {
  if (path.length === 0) return props;
  const [head, ...rest] = path;
  const clone: Schema = { ...props };
  if (typeof head !== "string") return props;
  clone[head] = rest.length === 0 ? url : setDeep(clone[head], rest, url);
  return clone;
}

function setDeep(
  value: unknown,
  path: (string | number)[],
  url: string,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return url;
  if (typeof head === "number") {
    if (!Array.isArray(value)) return value;
    const copy = [...value];
    copy[head] = rest.length === 0 ? url : setDeep(copy[head], rest, url);
    return copy;
  }
  const record = asSchema(value);
  if (!record) return value;
  return {
    ...record,
    [head]: rest.length === 0 ? url : setDeep(record[head], rest, url),
  };
}

/** {@link clearSentinels} over a block's props. */
export function clearUnfilled(props: Schema): Schema {
  return clearSentinels(props);
}
