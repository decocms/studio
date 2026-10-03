/**
 * The secret guard: the content protocol refuses plain text in a `Secret`
 * field, so the site editor and agents can't save a credential by mistake.
 *
 * A `Secret` field must hold a `secret` block with a well-formed
 * `ciphertext` (`{ "__resolveType": "secret", "ciphertext": "v1.…" }`, in the
 * format `./ciphertext` pins: three base64url segments of checked lengths), or a
 * variant block whose every value does. Every `secret` block anywhere in an
 * entry must carry a well-formed `ciphertext`, whatever its field.
 *
 * The schema marks a `Secret` field with `"format": "secret"` — the contract
 * `deco schema` emits for the `Secret` type. Browser-safe.
 */
import { parseCiphertext } from "./ciphertext";
import type { BlockViolation } from "./errors";
import type { DecoMeta } from "./types";

/** The built-in block type that holds an encrypted value. */
export const SECRET_BLOCK_TYPE = "secret";

/** The JSON Schema `format` that marks a `Secret` field. */
export const SECRET_FORMAT = "secret";

const MULTIVARIATE_TYPES = new Set([
  "multivariate",
  "website/flags/multivariate.ts",
]);
const LAZY_TYPE = "lazy";
const MAX_DEPTH = 512;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveTypeOf = (value: unknown): string | undefined =>
  isObject(value) && typeof value.__resolveType === "string"
    ? value.__resolveType
    : undefined;

const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * True when `ciphertext` is a well-formed secret ciphertext:
 * `v1.<wrappedKey>.<iv>.<ciphertext>` with segment lengths an RSA-OAEP and
 * AES-256-GCM encryption produces. Checking it needs no key.
 */
export function isWellFormedCiphertext(
  ciphertext: unknown,
): ciphertext is string {
  return parseCiphertext(ciphertext) !== null;
}

/** True when a JSON Schema node describes a `Secret` field. */
export function isSecretFieldSchema(schema: unknown): boolean {
  return isObject(schema) && schema.format === SECRET_FORMAT;
}

/** True when `value` is a `secret` block with a well-formed `ciphertext`. */
export function isSecretBlock(value: unknown): boolean {
  return (
    resolveTypeOf(value) === SECRET_BLOCK_TYPE &&
    isWellFormedCiphertext((value as Json).ciphertext)
  );
}

const blockIndexCache = new WeakMap<object, Map<string, unknown>>();

/** Every block type in the schema's manifest, by key, to the schema of its arguments. */
function blockIndex(meta: DecoMeta): Map<string, unknown> {
  const cached = blockIndexCache.get(meta);
  if (cached) return cached;
  const index = new Map<string, unknown>();
  for (const group of Object.values(meta.manifest?.blocks ?? {})) {
    if (!isObject(group)) continue;
    for (const [key, schema] of Object.entries(group)) {
      if (!index.has(key)) index.set(key, schema);
    }
  }
  blockIndexCache.set(meta, index);
  return index;
}

class SecretWalker {
  readonly violations: BlockViolation[] = [];

  constructor(
    private readonly name: string,
    private readonly meta: DecoMeta | null,
  ) {}

  private report(pointer: string, rule: string, message: string) {
    this.violations.push({ name: this.name, pointer, rule, message });
  }

  /** Follows local `$ref`s into `schema.definitions`. */
  private deref(schema: unknown): unknown {
    let current = schema;
    for (
      let hops = 0;
      hops < 32 && isObject(current) && typeof current.$ref === "string";
      hops++
    ) {
      const match = /^#\/definitions\/(.+)$/.exec(current.$ref);
      if (!match) return current;
      const key = decodeURIComponent(match[1]!)
        .replace(/~1/g, "/")
        .replace(/~0/g, "~");
      current = this.meta?.schema?.definitions?.[key];
    }
    return current;
  }

  /** The schemas of a node, flattened through `allOf`/`anyOf`/`oneOf`. */
  private branches(schema: unknown, depth = 0): Json[] {
    const node = this.deref(schema);
    if (!isObject(node) || depth > 16) return [];
    const out: Json[] = [node];
    for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
      const list = node[combinator];
      if (Array.isArray(list))
        for (const item of list) out.push(...this.branches(item, depth + 1));
    }
    return out;
  }

  private isSecretField(schema: unknown): boolean {
    return this.branches(schema).some(isSecretFieldSchema);
  }

  private propertySchema(schema: unknown, key: string): unknown {
    for (const branch of this.branches(schema)) {
      const properties = branch.properties;
      if (isObject(properties) && key in properties) return properties[key];
    }
    for (const branch of this.branches(schema)) {
      if (isObject(branch.additionalProperties))
        return branch.additionalProperties;
    }
    return undefined;
  }

  private itemSchema(schema: unknown): unknown {
    for (const branch of this.branches(schema)) {
      if (isObject(branch.items)) return branch.items;
    }
    return undefined;
  }

  /** A value stored in a `Secret` field. */
  checkSecretValue(value: unknown, pointer: string, depth: number) {
    if (depth > MAX_DEPTH)
      return this.report(pointer, "too-deep", "the value is nested too deeply");
    const type = resolveTypeOf(value);
    if (type === SECRET_BLOCK_TYPE)
      return this.walkBlock(value as Json, pointer, depth);
    if (type !== undefined && MULTIVARIATE_TYPES.has(type)) {
      const variants = (value as Json).variants;
      if (!Array.isArray(variants)) {
        return this.report(
          pointer,
          "secret-field",
          "a Secret field holds a variant block without variants",
        );
      }
      for (const [index, variant] of variants.entries()) {
        const at = `${pointer}/variants/${index}`;
        if (!isObject(variant)) {
          this.report(at, "secret-field", "a variant must be an object");
          continue;
        }
        if (variant.rule !== undefined)
          this.walkAny(variant.rule, `${at}/rule`, depth + 1);
        let inner = variant.value;
        let innerAt = `${at}/value`;
        if (resolveTypeOf(inner) === LAZY_TYPE) {
          inner = (inner as Json).value;
          innerAt = `${innerAt}/value`;
        }
        this.checkSecretValue(inner, innerAt, depth + 1);
      }
      return;
    }
    this.report(
      pointer,
      "secret-field",
      'a Secret field must hold a "secret" block with a well-formed ciphertext, never plain text',
    );
  }

  /** A block value: its own definition (from the manifest) describes its arguments. */
  walkBlock(block: Json, pointer: string, depth: number) {
    const type = block.__resolveType as string;
    if (
      type === SECRET_BLOCK_TYPE &&
      !isWellFormedCiphertext(block.ciphertext)
    ) {
      this.report(
        pointer,
        "secret-ciphertext",
        'a "secret" block must carry a well-formed "ciphertext" (v1.<wrappedKey>.<iv>.<ciphertext>)',
      );
    }
    const definition = this.meta ? blockIndex(this.meta).get(type) : undefined;
    this.walkObject(block, definition, pointer, depth);
  }

  private walkObject(
    object: Json,
    schema: unknown,
    pointer: string,
    depth: number,
  ) {
    for (const [key, child] of Object.entries(object)) {
      if (key === "__resolveType") continue;
      const childSchema =
        schema === undefined ? undefined : this.propertySchema(schema, key);
      this.walk(
        child,
        childSchema,
        `${pointer}/${escapePointer(key)}`,
        depth + 1,
      );
    }
  }

  walk(value: unknown, schema: unknown, pointer: string, depth: number) {
    if (depth > MAX_DEPTH)
      return this.report(pointer, "too-deep", "the value is nested too deeply");
    if (schema !== undefined && this.isSecretField(schema)) {
      return this.checkSecretValue(value, pointer, depth);
    }
    if (Array.isArray(value)) {
      const items = schema === undefined ? undefined : this.itemSchema(schema);
      for (const [index, item] of value.entries()) {
        this.walk(item, items, `${pointer}/${index}`, depth + 1);
      }
      return;
    }
    if (!isObject(value)) return;
    // A nested block is described by its own definition, not the field's union.
    if (resolveTypeOf(value) !== undefined)
      return this.walkBlock(value, pointer, depth);
    this.walkObject(value, schema, pointer, depth);
  }

  walkAny(value: unknown, pointer: string, depth: number) {
    this.walk(value, undefined, pointer, depth);
  }
}

/**
 * Checks one entry against the secret guard. `meta` is the parsed schema;
 * without one, only the `secret` blocks' ciphertexts can be checked.
 */
export function checkSecrets(
  name: string,
  entry: unknown,
  meta: DecoMeta | null,
): BlockViolation[] {
  const walker = new SecretWalker(name, meta);
  walker.walk(entry, undefined, "", 0);
  return walker.violations;
}
