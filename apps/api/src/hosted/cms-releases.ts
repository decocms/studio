/**
 * The Releases tab on the hosted CMS (contract §4.7): one delimiter LIST of
 * `revisions/`, 50 revision folders a page, newest first (the ids' inverted
 * time prefix), then one `meta.json` GET per folder; a folder without
 * `meta.json` (a publish that crashed before it) is skipped, unless
 * latest.json names it (then it is `unreadable`).
 *
 * Every listed revision is a plain row, except the one latest.json names
 * (`current`). `meta.previous` isn't walked: the list says nothing about
 * which revisions went live.
 *
 * The first page LISTs from `StartAfter` = the id floor of a day from now.
 * `revisions/` may still hold the first v8 format's flat `<commit-sha>.json`
 * files (#8062); S3's MaxKeys counts those with the folders, so listing
 * from the start returned pages of nothing but them. Every revision id
 * minted so far sorts above the floor (the day absorbs clock skew between
 * Studio instances), and a SHA sorts below it unless it starts higher
 * (~1 in 150, e.g. `ff…`): those few still take a slot, never a page.
 *
 * A `meta.json` that doesn't parse never fails the page: the folder is an
 * `unreadable` row with its id only. A failed GET (R2 429/5xx/network)
 * fails it like any other read (503 `unavailable`).
 */

import {
  MalformedObjectError,
  readLatest,
  readRevisionMeta,
  type RevisionMeta,
} from "./cms-release";
import { type DeliveryStore, deliveryKeys } from "./delivery-store";
import { isRevisionId, revisionIdFloor } from "./revision-id";

export const RELEASES_PAGE_SIZE = 50;

/** How far past now the listing floor sits, for clock skew between instances. */
const FLOOR_SKEW_MS = 24 * 60 * 60 * 1000;

/** `current`: the one latest.json names; `listed`: any other. */
export type ReleaseStatus = "current" | "listed";

export type ReleaseRow =
  | { id: string; status: ReleaseStatus; meta: RevisionMeta }
  /** Its meta.json couldn't be read: the id only, no meta fields. */
  | { id: string; status: "unreadable" };

export interface ReleasesPage {
  live: string | null;
  revisions: ReleaseRow[];
  nextCursor: string | null;
}

interface Cursor {
  token: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

/** The cursor, or null when it isn't one this Studio wrote. */
export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf-8"),
    ) as { token?: unknown } | null;
    if (typeof parsed?.token !== "string" || !parsed.token) return null;
    return { token: parsed.token };
  } catch {
    return null;
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

const UNREADABLE = Symbol("unreadable");

/** The folder's meta, null when it has none, UNREADABLE when it doesn't parse. */
async function readListedMeta(
  store: DeliveryStore,
  site: string,
  id: string,
): Promise<RevisionMeta | null | typeof UNREADABLE> {
  try {
    return await readRevisionMeta(store, site, id);
  } catch (error) {
    if (error instanceof MalformedObjectError) return UNREADABLE;
    throw error;
  }
}

export async function listCmsReleases(
  store: DeliveryStore,
  site: string,
  cursor: string | null,
  nowMs: number = Date.now(),
): Promise<ReleasesPage> {
  const from = cursor ? decodeCursor(cursor) : null;
  if (cursor && !from) throw new InvalidCursorError();
  const latest = await readLatest(store, site);
  const live = latest?.latest.revision ?? null;
  const prefix = deliveryKeys.revisions(site);
  const page = await store.listPage(prefix, {
    delimiter: "/",
    maxKeys: RELEASES_PAGE_SIZE,
    continuationToken: from?.token ?? null,
    startAfter: prefix + revisionIdFloor(nowMs + FLOOR_SKEW_MS),
  });
  const ids = page.prefixes
    .map((p) => p.slice(prefix.length).replace(/\/$/, ""))
    .filter(isRevisionId);
  const metas = await Promise.all(
    ids.map((id) => readListedMeta(store, site, id)),
  );
  const revisions: ReleaseRow[] = [];
  for (const [i, id] of ids.entries()) {
    const meta = metas[i];
    if (meta === UNREADABLE || (meta === null && id === live))
      revisions.push({ id, status: "unreadable" });
    else if (meta)
      revisions.push({
        id,
        status: id === live ? "current" : "listed",
        meta,
      });
  }
  return {
    live,
    revisions,
    nextCursor: page.nextToken ? encodeCursor({ token: page.nextToken }) : null,
  };
}
