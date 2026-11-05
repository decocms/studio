/**
 * Publish, rollback and roll-forward on the hosted CMS (design "Publish";
 * contract §4.5–§4.6). A publish commits at exactly one point, the
 * conditional PUT of `latest.json`, which always comes after every object
 * the new index points at is written. It never reads an unchanged block's
 * body.
 *
 * Publish a draft:
 *   1. read latest.json (ETag L), the base index; none = first publish;
 *   2. read the draft index, then every listed file with its ETag; a
 *      missing file or a `published` marker is skipped;
 *   3. for each set block, PUT `blocks/<hash>.json` create-only (a 412 is
 *      "already there"), unless the base already names that hash;
 *   4. copy the index, replacing the changed entries and dropping the
 *      deleted names, with `sequence` one higher; equal entries → skip to 8
 *      (`up-to-date`);
 *   5. PUT `revisions/<id>/index.json`, then `meta.json`, create-only;
 *   6. PUT latest.json with `If-Match: L` (create-only on a first publish):
 *      live once it lands. A lost race starts again from 1, rereading the
 *      draft too; 3 attempts in total, then `ProductionMovedError` (409);
 *   7. purge latest.json at the CDN (best effort, logged);
 *   8. empty the draft: for each file read in 2 of the committing attempt,
 *      PUT a `published` marker with `If-Match` on that read's ETag (a 412
 *      is a newer save, which stays), then drop from the draft index only
 *      the names whose marker landed.
 *
 * A rollback is a publish with no draft (1, 4–7): a copy of the target's
 * index under a new id and the next `sequence`, with `reapplyOf`; no block
 * object is written, since every hash exists. A no-op when it equals the
 * live index; refused before the site's first publish (`NotPublishedError`,
 * 409 `not_published`).
 */

import { canonicalJson } from "@decocms/blocks/protocol";
import {
  datedReleaseNote,
  LEGACY_MADE_CURRENT_PREFIX,
  MADE_CURRENT_PREFIX,
  NO_NOTE_TITLE,
  UNKNOWN_RELEASE_NOTE,
} from "@decocms/shared/release-notes";
import type { CmsVia } from "@/storage/types";
import { type BlockIndex, type IndexEntry, indexEntry } from "./block-meta";
import {
  type DraftFileRead,
  type DraftState,
  holdsName,
  readDraftState,
  updateDraftIndex,
  writeDraftFile,
} from "./cms-drafts";
import {
  type Latest,
  MAX_BLOCK_BYTES,
  MAX_INDEX_BYTES,
  readLatest,
  readRevisionIndex,
  readRevisionMeta,
  type RevisionMeta,
  serializeIndex,
  writeBlockObject,
  writeLatest,
  writeRevision,
} from "./cms-release";
import type { DeliveryPurge } from "./delivery-purge";
import {
  type DeliveryStore,
  deliveryKeys,
  ObjectChangedError,
} from "./delivery-store";
import { newRevisionId } from "./revision-id";

/** Today's `PUBLISH_COMMIT_ATTEMPTS`: attempts in total on a lost race. */
export const PUBLISH_ATTEMPTS = 3;

/** latest.json moved under every attempt: nothing was published. */
export class ProductionMovedError extends Error {
  constructor() {
    super("production moved, try again");
    this.name = "ProductionMovedError";
  }
}

/** An index or a block object over its cap (contract §2.2, §2.5). */
export class RevisionTooLargeError extends Error {
  constructor(what: string, bytes: number, limit: number) {
    super(`${what} is ${bytes} bytes; the limit is ${limit}`);
    this.name = "RevisionTooLargeError";
  }
}

/** The rollback target has no meta.json: not a revision. */
export class RevisionNotFoundError extends Error {
  constructor(id: string) {
    super(`revision ${id} not found`);
    this.name = "RevisionNotFoundError";
  }
}

/** A rollback before the site's first publish: no latest.json to roll back. */
export class NotPublishedError extends Error {
  constructor() {
    super("the site has no published release yet; publish a draft first");
    this.name = "NotPublishedError";
  }
}

export interface CmsPublishDeps {
  store: DeliveryStore;
  purge: DeliveryPurge;
  site: string;
  /** The site's preview hosts (preview-hosts.ts), written into latest.json only. */
  previewHosts: readonly string[];
  /** The caller (Studio user id) and how it called (server-derived). */
  author: string;
  via: CmsVia;
  /** Test seams. */
  now?: () => Date;
  newId?: () => string;
  /** Runs before each latest.json write (tests make races here). */
  beforeLatestWrite?: (attempt: number) => Promise<void>;
}

/** Step 7's purge: best effort, only logged. */
async function purgeLatest(deps: CmsPublishDeps) {
  const key = deliveryKeys.latest(deps.site);
  try {
    await deps.purge.purge(key);
  } catch (error) {
    console.error(
      "cms publish: purging latest.json failed; edges may lag up to 1 h",
      {
        site: deps.site,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Steps 5–7 over the latest.json read in this attempt: writes the revision,
 * then moves latest.json. Returns the new id, or null on a lost race.
 */
async function writeAndPoint(
  deps: CmsPublishDeps,
  base: { latest: Latest; etag: string | null } | null,
  blocks: BlockIndex,
  meta: Omit<RevisionMeta, "previous" | "publishedAt" | "author" | "via">,
  attempt: number,
): Promise<string | null> {
  const id = (deps.newId ?? newRevisionId)();
  const index = {
    revision: id,
    sequence: (base?.latest.sequence ?? 0) + 1,
    blocks,
  };
  const text = serializeIndex(index);
  const bytes = utf8Length(text);
  if (bytes > MAX_INDEX_BYTES) {
    throw new RevisionTooLargeError("the index", bytes, MAX_INDEX_BYTES);
  }
  await writeRevision(deps.store, deps.site, text, id, {
    ...meta,
    previous: base?.latest.revision ?? null,
    author: deps.author,
    via: deps.via,
    publishedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  await deps.beforeLatestWrite?.(attempt);
  try {
    await writeLatest(
      deps.store,
      deps.site,
      { ...index, previewHosts: [...deps.previewHosts] },
      base?.etag ?? null,
    );
  } catch (error) {
    if (error instanceof ObjectChangedError) return null;
    throw error;
  }
  await purgeLatest(deps);
  return id;
}

/**
 * Step 4: the base index with the draft's set names replaced in place (or
 * appended, code-unit order) and its deleted names removed. `meta` of a set
 * name is computed over the new index's names.
 */
export async function composeIndex(
  base: BlockIndex,
  sets: ReadonlyMap<string, Record<string, unknown>>,
  deletes: ReadonlySet<string>,
): Promise<BlockIndex> {
  const names = new Set(
    [...Object.keys(base), ...sets.keys()].filter(
      (n) => sets.has(n) || !deletes.has(n),
    ),
  );
  const out: Array<[string, IndexEntry]> = [];
  for (const [name, entry] of Object.entries(base)) {
    if (sets.has(name))
      out.push([name, await indexEntry(name, sets.get(name), names)]);
    else if (!deletes.has(name)) out.push([name, entry]);
  }
  const added = [...sets.keys()].filter((n) => !Object.hasOwn(base, n)).sort();
  for (const name of added) {
    out.push([name, await indexEntry(name, sets.get(name), names)]);
  }
  // fromEntries: an entry named "__proto__" stays an entry.
  return Object.fromEntries(out);
}

export type CmsPublishResult =
  | {
      result: "published";
      revision: string;
      previous: string | null;
      draftEmptied: boolean;
    }
  | { result: "up-to-date"; revision: string | null; draftEmptied: boolean };

/** The draft's own files (step 2): `set` and `delete` only. */
function heldFiles(state: DraftState) {
  const held: Array<[string, DraftFileRead]> = [];
  for (const [name, read] of state.files)
    if (holdsName(read)) held.push([name, read]);
  return held;
}

/**
 * Step 8: a `published` marker over each held file, `If-Match` on its
 * read; then the names whose marker landed leave the draft index. True when
 * every marker landed.
 */
async function emptyDraft(
  deps: CmsPublishDeps,
  slug: string,
  draftName: string,
  state: DraftState,
  revision: string | null,
  index: BlockIndex,
): Promise<boolean> {
  const { store, site } = deps;
  const held = heldFiles(state);
  if (held.length === 0) return false;
  const landed = new Set<string>();
  for (const [name, read] of held) {
    try {
      await writeDraftFile(
        store,
        site,
        slug,
        name,
        {
          operation: "published",
          revision,
          version:
            read.file?.operation === "set"
              ? (index[name]?.version ?? null)
              : null,
        },
        read.etag,
      );
      landed.add(name);
    } catch (error) {
      // A save landed during the publish (412): it stays in the draft.
      if (!(error instanceof ObjectChangedError)) {
        console.error("cms publish: emptying a draft file failed", {
          site,
          draft: draftName,
          block: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (landed.size > 0) {
    try {
      await updateDraftIndex(store, site, slug, (names) =>
        names.filter((n) => !landed.has(n)),
      );
    } catch (error) {
      // The markers read as "not in the draft" anyway.
      console.error("cms publish: updating the draft index failed", {
        site,
        draft: draftName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return landed.size === held.length;
}

/** Publish the draft at `slug` (named `draftName`): steps 1–8. */
export async function publishCmsDraft(
  deps: CmsPublishDeps,
  draft: { name: string; slug: string },
  message: string,
): Promise<CmsPublishResult> {
  const { store, site } = deps;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    const base = await readLatest(store, site);
    const state = await readDraftState(store, site, draft.slug);
    const baseBlocks = base?.latest.blocks ?? {};
    const sets = new Map<string, Record<string, unknown>>();
    const deletes = new Set<string>();
    for (const [name, read] of heldFiles(state)) {
      if (read.file?.operation === "set") sets.set(name, read.file.data);
      else deletes.add(name);
    }
    const blocks = await composeIndex(baseBlocks, sets, deletes);
    if (canonicalJson(blocks) === canonicalJson(baseBlocks)) {
      return {
        result: "up-to-date",
        revision: base?.latest.revision ?? null,
        draftEmptied: await emptyDraft(
          deps,
          draft.slug,
          draft.name,
          state,
          base?.latest.revision ?? null,
          blocks,
        ),
      };
    }
    const known = new Set(Object.values(baseBlocks).map((e) => e.version));
    const texts = new Map<string, string>();
    for (const [name, data] of sets) {
      const version = blocks[name]!.version;
      if (known.has(version) || texts.has(version)) continue;
      const text = JSON.stringify(data);
      const bytes = utf8Length(text);
      if (bytes > MAX_BLOCK_BYTES) {
        throw new RevisionTooLargeError(
          `the block ${name}`,
          bytes,
          MAX_BLOCK_BYTES,
        );
      }
      texts.set(version, text);
    }
    for (const [version, text] of texts) {
      await writeBlockObject(store, site, version, text);
    }
    const id = await writeAndPoint(
      deps,
      base,
      blocks,
      { draft: draft.name, message: message.trim() },
      attempt,
    );
    if (id === null) continue;
    return {
      result: "published",
      revision: id,
      previous: base?.latest.revision ?? null,
      draftEmptied: await emptyDraft(
        deps,
        draft.slug,
        draft.name,
        state,
        id,
        blocks,
      ),
    };
  }
  throw new ProductionMovedError();
}

/** `2026-10-14 13:05 UTC`, or null for an unreadable date. */
function utcMinute(date: string): string | null {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The new version's title for reapplying a version whose note is `message`
 * and date `date`: `Made current: <its note>`. Reapplying a reapplied
 * version keeps the one prefix (an older `Reapply: ` becomes `Made
 * current: `); a version without a note is named by its date.
 */
function reapplyTitle(original: { message: string; date: string }): string {
  const title = original.message.split("\n")[0]?.trim() ?? "";
  if (
    title.startsWith(MADE_CURRENT_PREFIX) &&
    title.length > MADE_CURRENT_PREFIX.length
  )
    return title;
  if (
    title.startsWith(LEGACY_MADE_CURRENT_PREFIX) &&
    title.length > LEGACY_MADE_CURRENT_PREFIX.length
  ) {
    return `${MADE_CURRENT_PREFIX}${title.slice(LEGACY_MADE_CURRENT_PREFIX.length)}`;
  }
  if (title && !NO_NOTE_TITLE.test(title))
    return `${MADE_CURRENT_PREFIX}${title}`;
  const when = utcMinute(original.date);
  return `${MADE_CURRENT_PREFIX}${when ? datedReleaseNote(when) : UNKNOWN_RELEASE_NOTE}`;
}

export type CmsRollbackResult =
  | { result: "published"; revision: string; previous: string }
  | { result: "up-to-date"; revision: string };

/**
 * Rollback / roll-forward to `target`, any revision with a readable
 * meta.json and index.json (whether latest.json ever named it or not):
 * steps 1 and 4–7, writing no block object. Refused before the first
 * publish (`NotPublishedError`).
 */
export async function rollbackToRevision(
  deps: CmsPublishDeps,
  target: string,
  message: string,
): Promise<CmsRollbackResult> {
  const { store, site } = deps;
  const targetMeta = await readRevisionMeta(store, site, target);
  if (!targetMeta) throw new RevisionNotFoundError(target);
  const wanted = await readRevisionIndex(store, site, target);
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    const live = await readLatest(store, site);
    if (!live) throw new NotPublishedError();
    if (canonicalJson(wanted.blocks) === canonicalJson(live.latest.blocks)) {
      return { result: "up-to-date", revision: live.latest.revision };
    }
    const id = await writeAndPoint(
      deps,
      live,
      wanted.blocks,
      {
        reapplyOf: target,
        message:
          message.trim() ||
          reapplyTitle({
            message: targetMeta.message,
            date: targetMeta.publishedAt,
          }),
      },
      attempt,
    );
    if (id === null) continue;
    return {
      result: "published",
      revision: id,
      previous: live.latest.revision,
    };
  }
  throw new ProductionMovedError();
}
