/**
 * Publish, rollback and roll-forward on the hosted CMS (design "Publish,
 * rollback and roll-forward"; contract §4.9, §4.11). A publish commits at
 * exactly one point: the conditional PUT of `latest.json`, which always
 * comes after the revision it names is written.
 *
 * Publish a draft:
 *   1. read latest.json (ETag L): revision V;
 *   2. read the draft once (ETag D);
 *   3. compose V.blocks ⊕ draft; when every draft block already equals
 *      production's, skip to 6;
 *   4. PUT revisions/<new>/data.json, then meta.json (`previous: V`), each
 *      create-only; data.json `\uXXXX`-escaped;
 *   5. PUT latest.json `{revision, previewHosts}` with `If-Match: L`
 *      (create-only on a site's first publish), then purge it from the CDN.
 *      Live once this PUT lands; a purge failure is only logged. On a lost
 *      race repeat 1 and 3–5 with the same draft: 3 attempts in total, then
 *      `ProductionMovedError` (409 "production moved, try again");
 *   6. empty the draft in place with `If-Match: D`; a save made meanwhile
 *      (412) keeps it as it is.
 *
 * A rollback is a publish with no draft (steps 1, 4, 5): a new revision
 * whose blocks are exactly the target's, with `reapplyOf`; a no-op when
 * they equal the live blocks as a whole. Only a revision that went live
 * (reached from latest.json through `previous`) can be reapplied.
 *
 * No step reads git.
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
import {
  emptyDraftBody,
  isEmptyDraftBody,
  readDraftObject,
  writeDraftObject,
} from "./cms-drafts";
import {
  applyDraftToBlocks,
  type Blocks,
  draftChangesNothing,
  type LatestPointer,
  MAX_SNAPSHOT_BYTES,
  MalformedObjectError,
  readLatestPointer,
  readRevision,
  readRevisionMeta,
  type RevisionMeta,
  serializeRevisionData,
  writeLatestPointer,
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

/** The composed data.json is over the SDK's revision cap. */
export class RevisionTooLargeError extends Error {
  constructor(bytes: number) {
    super(`the revision is ${bytes} bytes; the limit is ${MAX_SNAPSHOT_BYTES}`);
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

/** latest.json never named the rollback target. */
export class NeverLiveError extends Error {
  constructor(id: string) {
    super(`revision ${id} never went live`);
    this.name = "NeverLiveError";
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

/** Step 5's purge: best effort, only logged. */
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

/**
 * Steps 4–5 over the latest.json read in this attempt: writes the revision,
 * then moves latest.json. Returns the new id, or null on a lost race.
 */
async function writeAndPoint(
  deps: CmsPublishDeps,
  latest: { pointer: LatestPointer; etag: string | null } | null,
  blocks: Blocks,
  meta: Omit<RevisionMeta, "previous" | "publishedAt" | "author" | "via">,
  attempt: number,
): Promise<string | null> {
  const data = serializeRevisionData(blocks);
  // Pure ASCII after the escaping: its length is its size in bytes.
  const bytes = data.length;
  if (bytes > MAX_SNAPSHOT_BYTES) throw new RevisionTooLargeError(bytes);
  const id = (deps.newId ?? newRevisionId)();
  await writeRevision(deps.store, deps.site, id, data, {
    ...meta,
    previous: latest?.pointer.revision ?? null,
    author: deps.author,
    via: deps.via,
    publishedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  await deps.beforeLatestWrite?.(attempt);
  try {
    await writeLatestPointer(
      deps.store,
      deps.site,
      { revision: id, previewHosts: [...deps.previewHosts] },
      latest?.etag ?? null,
    );
  } catch (error) {
    if (error instanceof ObjectChangedError) return null;
    throw error;
  }
  await purgeLatest(deps);
  return id;
}

export type CmsPublishResult =
  | {
      result: "published";
      revision: string;
      previous: string | null;
      draftEmptied: boolean;
    }
  | { result: "up-to-date"; revision: string | null; draftEmptied: boolean };

/** Publish the draft at `slug` (named `draftName`): steps 1–6. */
export async function publishCmsDraft(
  deps: CmsPublishDeps,
  draft: { name: string; slug: string },
  message: string,
): Promise<CmsPublishResult> {
  const { store, site } = deps;
  let latest = await readLatestPointer(store, site);
  // Step 2, once per publish: every attempt applies this same body.
  const read = await readDraftObject(store, site, draft.slug);
  const emptyDraft = async (): Promise<boolean> => {
    if (isEmptyDraftBody(read.body)) return false;
    try {
      await writeDraftObject(
        store,
        site,
        draft.slug,
        emptyDraftBody(),
        read.etag,
      );
      return true;
    } catch (error) {
      // A save landed during the publish (412): the draft is kept as is.
      if (!(error instanceof ObjectChangedError)) {
        console.error("cms publish: emptying the draft failed", {
          site,
          draft: draft.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  };
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    if (attempt > 1) latest = await readLatestPointer(store, site);
    const live = latest
      ? (await readRevision(store, site, latest.pointer.revision)).blocks
      : {};
    if (draftChangesNothing(live, read.body)) {
      return {
        result: "up-to-date",
        revision: latest?.pointer.revision ?? null,
        draftEmptied: await emptyDraft(),
      };
    }
    const id = await writeAndPoint(
      deps,
      latest,
      applyDraftToBlocks(live, read.body),
      { draft: draft.name, message: message.trim() },
      attempt,
    );
    if (id === null) continue;
    return {
      result: "published",
      revision: id,
      previous: latest?.pointer.revision ?? null,
      draftEmptied: await emptyDraft(),
    };
  }
  throw new ProductionMovedError();
}

/**
 * Whether `target` is `from` or reached from it through `previous`. A
 * meta.json missing or unparseable on the way breaks the chain: that is
 * `MalformedObjectError`, not "never live".
 */
export async function wentLive(
  store: DeliveryStore,
  site: string,
  from: string | null,
  target: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let id = from;
  while (id && !seen.has(id)) {
    if (id === target) return true;
    seen.add(id);
    const meta = await readRevisionMeta(store, site, id);
    if (!meta)
      throw new MalformedObjectError(deliveryKeys.revisionMeta(site, id));
    id = meta.previous;
  }
  return false;
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

/** Rollback / roll-forward to `target`: steps 1, 4 and 5. */
export async function rollbackToRevision(
  deps: CmsPublishDeps,
  target: string,
  message: string,
): Promise<CmsRollbackResult> {
  const { store, site } = deps;
  const targetMeta = await readRevisionMeta(store, site, target);
  if (!targetMeta) throw new RevisionNotFoundError(target);
  let checked = false;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    const latest = await readLatestPointer(store, site);
    if (!latest) throw new NeverLiveError(target);
    // History only grows: once reached, it stays reachable.
    if (!checked) {
      if (!(await wentLive(store, site, latest.pointer.revision, target))) {
        throw new NeverLiveError(target);
      }
      checked = true;
    }
    const [wanted, live] = await Promise.all([
      readRevision(store, site, target),
      readRevision(store, site, latest.pointer.revision),
    ]);
    if (canonicalJson(wanted.blocks) === canonicalJson(live.blocks)) {
      return { result: "up-to-date", revision: latest.pointer.revision };
    }
    const id = await writeAndPoint(
      deps,
      latest,
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
      previous: latest.pointer.revision,
    };
  }
  throw new ProductionMovedError();
}
