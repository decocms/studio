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

/** Deco's marker for a prop holding an image address. */
const IMAGE_FORMAT = "image-uri";

/** What a model writes into an image prop when it wants one generated. */
export const IMAGE_SENTINEL = "generate:";

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

/**
 * One section's props, or `null` when the block cannot render them.
 *
 * Dropping beats repairing: a section missing a required prop renders empty,
 * and a shorter post is better than a gap in the middle of one. The caller
 * counts what it dropped and tells the person.
 */
export function readProps(raw: string, schema: Schema): Schema | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const pruned = pruneProps(parsed, schema);
  const record = asSchema(pruned);
  if (!record) return null;
  const { valid } = sharedJsonSchemaValidator.getValidator(schema)(record);
  return valid ? record : null;
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

/**
 * An image prop the model left as a sentinel we never generated.
 *
 * Shipping `generate:a woman packing a suitcase` as an image address renders a
 * broken image on a published page, so an unfilled request is blanked. The
 * editor's picker is two clicks.
 */
export function clearUnfilled(props: Schema, schema: Schema): Schema {
  let cleared = props;
  for (const request of imageRequests(props, schema)) {
    cleared = withImageAt(cleared, request.path, "");
  }
  return cleared;
}
