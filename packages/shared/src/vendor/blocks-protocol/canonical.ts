/**
 * Canonical JSON and content hashing. The implementation is a dependency-free
 * leaf module of the SDK (`src/v8/canonical.ts`), because the runtime checks
 * content revisions too; the protocol re-exports it so the CLI, the server
 * and the site editor share one definition.
 */
/**
 * Canonical JSON and hashing shared by the protocol's request digests.
 *
 * Canonical form: object keys recursively sorted in JavaScript code-unit
 * order, array order preserved, compact UTF-8 JSON with no trailing newline,
 * JSON string escaping and number encoding (negative zero becomes zero).
 * Values JSON can't represent (undefined, functions, symbols, bigints,
 * non-finite numbers, cycles) are rejected rather than silently dropped.
 *
 * Uses Web Crypto, so it runs in browsers, on Workers and on Node.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function write(
  value: unknown,
  path: string,
  seen: Set<object>,
  out: string[],
): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          `${path}: ${value} can't be represented in JSON`,
        );
      }
      out.push(Object.is(value, -0) ? "0" : JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      throw new CanonicalJsonError(
        `${path}: a ${typeof value} can't be represented in JSON`,
      );
  }
  const object = value as object;
  if (seen.has(object))
    throw new CanonicalJsonError(
      `${path}: a cycle can't be represented in JSON`,
    );
  seen.add(object);
  if (Array.isArray(object)) {
    out.push("[");
    object.forEach((item, index) => {
      if (index > 0) out.push(",");
      write(item, `${path}/${index}`, seen, out);
    });
    out.push("]");
  } else {
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        `${path}: only plain objects can be represented in JSON`,
      );
    }
    // Code-unit order, which is what the default sort compares.
    const keys = Object.keys(object).sort();
    out.push("{");
    keys.forEach((key, index) => {
      if (index > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      write(
        (object as Record<string, unknown>)[key],
        `${path}/${key}`,
        seen,
        out,
      );
    });
    out.push("}");
  }
  seen.delete(object);
}

/** Serializes `value` to canonical JSON. Throws CanonicalJsonError for values JSON can't represent. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, "", new Set(), out);
  return out.join("");
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** SHA-256 of `data` (strings are UTF-8 encoded), as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/**
 * The version of the canonical content-hashing format below. A snapshot
 * envelope records it beside the revision; the revision itself is excluded
 * from its own hash.
 */
export const CONTENT_HASH_FORMAT = 1;

/**
 * The content revision of a `blocks` map: SHA-256 over its canonical JSON,
 * lowercase hex. The one definition the CLI, the release materializer and
 * the site editor's backend share; `contentHashFixtures` (in
 * `@decocms/blocks/protocol/conformance`) pins its output.
 *
 * This identifies content, not storage: a storage's `blocks.list` revision
 * is opaque and may be computed differently (from file versions).
 */
export async function computeContentRevision(
  blocks: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(canonicalJson(blocks));
}

/** The domain prefix of `blocks.apply` request digests, so they never equal another hash. */
export const APPLY_DIGEST_DOMAIN = "deco-content/blocks.apply@1\n";

/**
 * The digest a request key is bound to: SHA-256 over the domain prefix and
 * the canonical JSON of every supplied parameter.
 */
export function applyRequestDigest(params: object): Promise<string> {
  return sha256Hex(APPLY_DIGEST_DOMAIN + canonicalJson(params));
}
