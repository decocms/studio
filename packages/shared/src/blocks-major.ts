/**
 * The one Blocks v8 detector. A site is v8 when its schema's content says so:
 * `deco schema` writes a top-level `"blocksMajor": 8` into
 * `.deco/schema.gen.json`, and only that strict value counts. A missing
 * field, any other value (a future 9 is not v8), something that isn't a
 * schema object, unparseable text or a missing file are all v7.
 *
 * Every v8 decision, on the server and in the web app, goes through
 * {@link isV8Schema}: the hosted routes, the content backends (GitHub,
 * sandbox working tree, `deco serve`), Releases and site tokens. The project's
 * `metadata.blocksMajor` marker is only that predicate's cached answer for
 * main's schema, kept by the server: the server writes it right after running
 * the predicate, and nothing else writes it. The web app never decides from
 * it: it waits for main's schema, read over the content protocol
 * (`schema.get` on the project's `/decofile/…/rpc`, which answers any site,
 * `schema: null` for a v7 one), or reads the schema of its mode's backend. `blocks-major.test.ts` keeps
 * this the only detector.
 */

/** The Blocks major this Studio edits over the content protocol. */
export const BLOCKS_V8_MAJOR = 8;

/** The schema file `deco schema` writes, under the site's `.deco/`. */
const SCHEMA_FILE = "schema.gen.json";

/** Where a site's schema lives: `<packagePath>/.deco/schema.gen.json`. */
export function schemaGenPath(packagePath: string | null): string {
  return packagePath
    ? `${packagePath}/.deco/${SCHEMA_FILE}`
    : `.deco/${SCHEMA_FILE}`;
}

/** Whether a parsed schema is a Blocks v8 one (`"blocksMajor": 8`). */
export function isV8Schema(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as { blocksMajor?: unknown }).blocksMajor === BLOCKS_V8_MAJOR
  );
}

/** {@link isV8Schema} on schema text; unparseable or missing text is v7. */
export function isV8SchemaText(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  try {
    return isV8Schema(JSON.parse(text));
  } catch {
    return false;
  }
}

/** The project metadata key holding the cached answer for main's schema. */
export const BLOCKS_MAJOR_METADATA_KEY = "blocksMajor";

/**
 * The server's cached answer in `metadata.blocksMajor`: {@link isV8Schema} on
 * main's `.deco/schema.gen.json`, written by the server on create/import and
 * whenever it reads main's schema, which opening the project in the editor
 * does (cleared when main is no longer v8). A cache, never the decision: the hosted gates
 * recompute main's answer (using this only to know when their last answer
 * may be reused), a new thread's default runtime reads it, and the web app
 * never decides from it.
 */
export function isBlocksV8Project(
  metadata: object | null | undefined,
): boolean {
  return (
    (metadata as Record<string, unknown> | null | undefined)?.[
      BLOCKS_MAJOR_METADATA_KEY
    ] === BLOCKS_V8_MAJOR
  );
}

/**
 * The header a site editor sends with its decofile reads, publishes and
 * content-protocol calls: main's answer it acts on (`v8` or `v7`). When the
 * server's own answer for main differs (main changed during the session),
 * it refuses with 409 `{ code: MAIN_SCHEMA_CHANGED }` instead of serving
 * the other generation's shape, and the editor re-reads main's answer.
 */
export const MAIN_SCHEMA_HEADER = "x-deco-main-schema";

/** The 409 code for a request made on a main answer that is out of date. */
export const MAIN_SCHEMA_CHANGED = "main_schema_changed";

/**
 * The 503 code of the content-protocol route on a v8 main when Studio has no
 * hosted delivery (draft) bucket configured: main is v8, but its editor
 * can't open here.
 */
export const HOSTED_DELIVERY_UNCONFIGURED = "hosted_delivery_unconfigured";

/**
 * The content revision of a hosted v8 editor (Studio's content protocol on
 * GitHub): `<main head sha>~<draft ETag>` (`none` without a draft), so a save
 * or a new commit on main is a new revision. A save reads only the draft,
 * never main: it answers an empty main part, and the editor keeps the main
 * part of the revision it last read ({@link hostedRevisionParts}).
 */
export function hostedRevision(
  mainSha: string,
  draftEtag: string | null,
): string {
  return `${mainSha}~${draftEtag ?? "none"}`;
}

/** The two parts of a {@link hostedRevision}; null for any other revision. */
export function hostedRevisionParts(
  revision: string,
): { main: string; draft: string } | null {
  const at = revision.indexOf("~");
  if (at < 0) return null;
  return { main: revision.slice(0, at), draft: revision.slice(at + 1) };
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
  draft: Record<string, { block: unknown; version: string } | null>;
}
