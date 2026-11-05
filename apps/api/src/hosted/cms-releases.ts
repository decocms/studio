/**
 * The Releases tab on the hosted CMS (contract §4.10): one delimiter LIST of
 * `revisions/`, 50 revision folders a page, newest first (the ids' inverted
 * time prefix), then one `meta.json` GET per folder; a folder without
 * `meta.json` (a publish that crashed before it) is skipped, unless the walk
 * below expects it.
 *
 * Live is the revision latest.json names. Walking back from it through each
 * meta's `previous` says which revisions went live; any other is "never
 * live" (a lost publish race, or a crash before latest.json moved) and
 * can't be reapplied. The walk's next expected id rides in the cursor, so a
 * later page continues it.
 *
 * A `meta.json` that can't be read (unparseable, or its GET failed) never
 * fails the page: the folder is an `unreadable` row with its id only. So is
 * a folder the walk expects that has no `meta.json`. The walk stops at an
 * unreadable row it expected: every older revision is "never live", as
 * when the walk can't reach it.
 */

import {
  MalformedObjectError,
  readLatestPointer,
  readRevisionMeta,
  type RevisionMeta,
} from "./cms-release";
import {
  type DeliveryStore,
  DeliveryUnavailableError,
  deliveryKeys,
} from "./delivery-store";
import { isRevisionId } from "./revision-id";

export const RELEASES_PAGE_SIZE = 50;

export type ReleaseStatus = "current" | "was-live" | "never-live";

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
  expect: string | null;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

/** The cursor, or null when it isn't one this Studio wrote. */
export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf-8"),
    ) as {
      token?: unknown;
      expect?: unknown;
    };
    if (typeof parsed.token !== "string" || !parsed.token) return null;
    if (parsed.expect !== null && !isRevisionId(parsed.expect)) return null;
    return { token: parsed.token, expect: parsed.expect as string | null };
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

/** The folder's meta, null when it has none, UNREADABLE when it can't be read. */
async function readListedMeta(
  store: DeliveryStore,
  site: string,
  id: string,
): Promise<RevisionMeta | null | typeof UNREADABLE> {
  try {
    return await readRevisionMeta(store, site, id);
  } catch (error) {
    if (
      error instanceof MalformedObjectError ||
      error instanceof DeliveryUnavailableError
    )
      return UNREADABLE;
    throw error;
  }
}

export async function listCmsReleases(
  store: DeliveryStore,
  site: string,
  cursor: string | null,
): Promise<ReleasesPage> {
  const from = cursor ? decodeCursor(cursor) : null;
  if (cursor && !from) throw new InvalidCursorError();
  const latest = await readLatestPointer(store, site);
  const live = latest?.pointer.revision ?? null;
  let expect = from ? from.expect : live;
  const prefix = deliveryKeys.revisions(site);
  const page = await store.listPage(prefix, {
    delimiter: "/",
    maxKeys: RELEASES_PAGE_SIZE,
    continuationToken: from?.token ?? null,
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
    if (meta === UNREADABLE || (meta === null && id === expect)) {
      revisions.push({ id, status: "unreadable" });
      // A broken link: the walk can't go past it.
      if (id === expect) expect = null;
      continue;
    }
    if (!meta) continue;
    let status: ReleaseStatus = "never-live";
    if (id === expect) {
      status = id === live ? "current" : "was-live";
      expect = meta.previous;
    }
    revisions.push({ id, status, meta });
  }
  return {
    live,
    revisions,
    nextCursor: page.nextToken
      ? encodeCursor({ token: page.nextToken, expect })
      : null,
  };
}
