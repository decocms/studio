/**
 * The three read methods: `describe`, `schema.get` and `blocks.list`.
 */
import { publicKeyDerFromPem } from "../../ciphertext";
import { limitExceeded, notFound, unavailable } from "../../errors";
import {
  ASSETS_URL_PREFIX,
  type BlocksListResult,
  type DecoMeta,
  type DescribeResult,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type ReadParams,
  SCHEMA_FORMAT,
  type SchemaGetResult,
} from "../../types";
import { loadCurrentContent } from "../content";
import type { Core } from "../core";

const DEFAULT_SERVER = { name: "deco-blocks", version: "unknown" };

/** The largest `.deco/secrets.pub` served (a 16384-bit key's PEM is under 3 KiB). */
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;

/**
 * The public key `describe` may serve: a single `PUBLIC KEY` PEM block of at
 * most 16 KiB. Anything else (a private key committed by mistake, two
 * blocks, stray text) is never broadcast to the site editor.
 */
function servablePublicKey(text: string | null): string | null {
  if (text === null) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_PUBLIC_KEY_BYTES)
    return null;
  if (text.includes("PRIVATE KEY")) return null;
  return publicKeyDerFromPem(text) === null ? null : text;
}

export async function describe(core: Core): Promise<DescribeResult> {
  const description = await core.description();
  const stored = await core.storage.readSecretsPublicKey();
  const publicKey = servablePublicKey(stored);
  if (stored !== null && publicKey === null) {
    core.options.onError?.(
      new Error(
        ".deco/secrets.pub isn't a single PUBLIC KEY PEM block; describe reports no key",
      ),
    );
  }
  const readOnly = description.readOnly;
  return {
    protocol: PROTOCOL_NAME,
    version: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
    server: core.options.server ?? DEFAULT_SERVER,
    kind: description.kind,
    readOnly,
    root: description.root,
    schemaFormat: SCHEMA_FORMAT,
    refs: description.refs,
    writes: {
      idempotency: core.storage.getReceipt ? description.idempotency : null,
      schemaPreconditions: true,
    },
    pollIntervalMs: core.pollIntervalMs(description),
    limits: core.limits(description),
    preview: core.options.preview ?? null,
    assets:
      readOnly || description.assets === null
        ? null
        : {
            dir: description.assets.dir,
            urlPrefix: ASSETS_URL_PREFIX,
            maxBytes: description.assets.maxBytes,
          },
    secrets: publicKey === null ? null : { publicKey },
  };
}

/** Reads and parses the schema, enforcing the schema byte limit. */
export async function readSchema(
  core: Core,
  ref: string | undefined,
  maxSchemaBytes: number,
): Promise<{
  version: string;
  resolvedRef: string | null;
  text: string;
} | null> {
  const stored = await core.storage.readSchema({ ref });
  if (stored === null) return null;
  if (new TextEncoder().encode(stored.text).byteLength > maxSchemaBytes) {
    throw limitExceeded(`the schema is over ${maxSchemaBytes} bytes`, {
      limit: "maxSchemaBytes",
    });
  }
  return stored;
}

/** Parses schema text; a file caught mid-write is reported as Unavailable, never served torn. */
export function parseSchema(text: string): DecoMeta {
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    throw unavailable("the schema file is being written; retry shortly", 500);
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw unavailable("the schema file doesn't hold a JSON object", 500);
  }
  return schema as DecoMeta;
}

export async function schemaGet(
  core: Core,
  params: ReadParams,
): Promise<SchemaGetResult> {
  const description = await core.description();
  core.checkRef(description, params.ref);
  const limits = core.limits(description);
  const stored = await core.storage.readSchema({ ref: params.ref });
  if (stored === null) {
    throw notFound(
      "no schema: neither .deco/schema.gen.json nor .deco/meta.gen.json exists",
    );
  }
  if (
    params.ifNoneMatch !== undefined &&
    params.ifNoneMatch === stored.version
  ) {
    return { notModified: true, version: stored.version };
  }
  if (
    new TextEncoder().encode(stored.text).byteLength > limits.maxSchemaBytes
  ) {
    throw limitExceeded(`the schema is over ${limits.maxSchemaBytes} bytes`, {
      limit: "maxSchemaBytes",
    });
  }
  return {
    notModified: false,
    version: stored.version,
    resolvedRef: stored.resolvedRef,
    schema: parseSchema(stored.text),
  };
}

export async function blocksList(
  core: Core,
  params: ReadParams,
): Promise<BlocksListResult> {
  const description = await core.description();
  core.checkRef(description, params.ref);
  const limits = core.limits(description);
  const { snapshot, content } = await loadCurrentContent(
    core.storage,
    params.ref,
    { readAll: true, limits, cache: core.cache },
    (s) =>
      params.ifNoneMatch !== undefined && params.ifNoneMatch === s.revision,
  );
  if (content === null) {
    return {
      notModified: true,
      revision: snapshot.revision,
      resolvedRef: snapshot.resolvedRef,
    };
  }
  // Null-prototype maps, so an entry named like an Object.prototype key stays an entry.
  const blocks: Record<string, Record<string, unknown>> = Object.create(null);
  const versions: Record<string, string> = Object.create(null);
  for (const [name, entry] of content.entries) {
    if (entry.value === undefined) continue;
    blocks[name] = entry.value;
    versions[name] = entry.version;
  }
  return {
    notModified: false,
    revision: snapshot.revision,
    resolvedRef: snapshot.resolvedRef,
    blocks,
    versions,
    diagnostics: content.diagnostics,
  };
}
