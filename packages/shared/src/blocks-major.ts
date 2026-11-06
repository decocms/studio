/**
 * The one Blocks v8 detector. A site is v8 when its schema's content says so:
 * `deco schema` writes a top-level `"blocksMajor": 8` into
 * `.deco/schema.gen.json`, and only that strict value counts. A missing
 * field, any other value (a future 9 is not v8), something that isn't a
 * schema object, unparseable text or a missing file are all v7.
 *
 * Every v8 decision goes through {@link isV8Schema}, directly or through the
 * project's `metadata.blocksMajor` marker: `deco schema push` (the hosted
 * CMS's `PUT /schema`) runs the predicate on the schema it pushes and writes
 * the marker with a record of that push, and nothing else writes either (a
 * marker without the push record is ignored). The hosted routes, a new thread's
 * runtime, Releases and site tokens read the marker; the content backends
 * of an open editor (sandbox working tree, `deco serve`) read their own
 * schema. Nothing reads git for it. `blocks-major.test.ts` keeps this the
 * only detector.
 */

/** The Blocks major this Studio edits over the content protocol. */
export const BLOCKS_V8_MAJOR = 8;

/** Whether a parsed schema is a Blocks v8 one (`"blocksMajor": 8`). */
export function isV8Schema(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as { blocksMajor?: unknown }).blocksMajor === BLOCKS_V8_MAJOR
  );
}

/** The project metadata key holding the pushed schema's answer. */
export const BLOCKS_MAJOR_METADATA_KEY = "blocksMajor";

/**
 * The project metadata key recording the CMS schema push the marker came
 * from (`PUT /api/cms/:site/schema`): the site and the pushed schema's hash.
 * Only that route writes it, together with the marker, and a client write
 * can neither set nor clear it (`strip-server-managed-metadata.ts`).
 */
export const CMS_SCHEMA_PUSH_METADATA_KEY = "cmsSchemaPush";

/** The CMS schema push a project's v8 marker came from. */
export interface CmsSchemaPush {
  /** The site the schema was pushed to. */
  site: string;
  /** The SHA-256 (hex) of the schema text pushed. */
  sha256: string;
}

/** The project's recorded CMS schema push, or null when it has none. */
export function cmsSchemaPushOf(
  metadata: object | null | undefined,
): CmsSchemaPush | null {
  const push = (metadata as Record<string, unknown> | null | undefined)?.[
    CMS_SCHEMA_PUSH_METADATA_KEY
  ];
  if (typeof push !== "object" || push === null || Array.isArray(push)) {
    return null;
  }
  const { site, sha256 } = push as { site?: unknown; sha256?: unknown };
  return typeof site === "string" &&
    site !== "" &&
    typeof sha256 === "string" &&
    sha256 !== ""
    ? { site, sha256 }
    : null;
}

/**
 * The metadata keys a v8 schema push writes: the marker and the record of
 * the push it came from.
 */
export function blocksV8Metadata(push: CmsSchemaPush): {
  [BLOCKS_MAJOR_METADATA_KEY]: typeof BLOCKS_V8_MAJOR;
  [CMS_SCHEMA_PUSH_METADATA_KEY]: CmsSchemaPush;
} {
  return {
    [BLOCKS_MAJOR_METADATA_KEY]: BLOCKS_V8_MAJOR,
    [CMS_SCHEMA_PUSH_METADATA_KEY]: { site: push.site, sha256: push.sha256 },
  };
}

/**
 * Whether the project is a Blocks v8 site. The marker in
 * `metadata.blocksMajor` is {@link isV8Schema} on the schema `deco schema
 * push` last pushed (cleared when that schema isn't v8), and it counts only
 * alongside the record of that push ({@link CMS_SCHEMA_PUSH_METADATA_KEY}).
 * A `blocksMajor: 8` without one (a marker an earlier Studio derived from
 * git, or one copied over) is stale and ignored: the project is v7, with the
 * git-backed editor and decofile routes. Every hosted gate and the web app
 * read this; it is never derived from git.
 */
export function isBlocksV8Project(
  metadata: object | null | undefined,
): boolean {
  return (
    (metadata as Record<string, unknown> | null | undefined)?.[
      BLOCKS_MAJOR_METADATA_KEY
    ] === BLOCKS_V8_MAJOR && cmsSchemaPushOf(metadata) !== null
  );
}

/**
 * The version a hosted v8 draft gives a block it deletes (a tombstone): the
 * deleted block is in the draft, so a save guarded "must not exist in the
 * draft" (`ifMatch: null`) is refused, and one guarded by this version
 * passes. The same value as @decocms/blocks' `TOMBSTONE_VERSION` (protocol
 * 1.2), so a client shared with that protocol reads it the same way.
 */
export const DRAFT_TOMBSTONE_VERSION = "tombstone";

/**
 * What a refused hosted v8 save (a Conflict) carries besides the protocol's
 * `entries`: each refused block as the draft holds it now, so the editor
 * opens its reconcile flow without reading anything else. A block deleted
 * in the draft is `{ block: null, version: DRAFT_TOMBSTONE_VERSION }`; a
 * block the draft doesn't hold is `null` (main's copy shows: the editor
 * reads it).
 */
export interface DraftConflictBlocks {
  draft: Record<
    string,
    {
      block: unknown;
      version: string;
      /**
       * Who last changed the block in the draft, and when (Unix seconds),
       * from the same read as `block` and `version`; null when unknown.
       */
      editor: { userId: string; at: number } | null;
    } | null
  >;
}
