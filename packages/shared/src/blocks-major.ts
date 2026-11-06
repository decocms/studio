/**
 * Blocks v8 in Studio: what makes a schema v8, and what makes a project v8.
 *
 * - A schema is v8 when its content says so ({@link isV8Schema}): `deco
 *   schema` writes a top-level `"blocksMajor": 8` into
 *   `.deco/schema.gen.json`, and only that strict value counts. A missing
 *   field, any other value (a future 9 is not v8), something that isn't a
 *   schema object, unparseable text or a missing file are all v7. The content
 *   backends of an open editor (sandbox working tree, `deco serve`) read
 *   their own schema with it.
 * - A project is v8 when its "Blocks v8 site" switch is on
 *   ({@link isBlocksV8Project}): `metadata.blocksV8: true`, which only an
 *   org admin sets (project settings, or `blocksV8` on
 *   `COLLECTION_VIRTUAL_MCP_UPDATE`). It is the one source of truth for
 *   every project-level v8 gate, in the API and the web app: the hosted
 *   editor, the decofile 409, the sandbox-less git 404, a new thread's
 *   runtime, Experiments, Calendar, Releases, site tokens, Monitor. Nothing
 *   derives it: not git, not `deco schema push` (which a project with the
 *   switch off is refused), not an older `metadata.blocksMajor` marker.
 *   Turned off, the project is v7 again, exactly as on main.
 *
 * `blocks-major.test.ts` keeps these the only two predicates.
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

/**
 * The project metadata key of the "Blocks v8 site" switch: `true` when on,
 * absent when off. Server-managed: a client metadata write can neither set
 * nor clear it (`strip-server-managed-metadata.ts`); an org admin flips it
 * with the update tool's `blocksV8` field.
 */
export const BLOCKS_V8_METADATA_KEY = "blocksV8";

/**
 * Whether the project is a Blocks v8 site: its "Blocks v8 site" switch
 * ({@link BLOCKS_V8_METADATA_KEY}) is on. Only a strict `true` counts.
 * Every project-level v8 gate reads this, and nothing else.
 */
export function isBlocksV8Project(
  metadata: object | null | undefined,
): boolean {
  return (
    (metadata as Record<string, unknown> | null | undefined)?.[
      BLOCKS_V8_METADATA_KEY
    ] === true
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
