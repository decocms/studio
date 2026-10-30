/**
 * The blog's editorial state, in the organization's brand folder.
 *
 * Brand, writing rules and formats are the brand's own guide,
 * `home/brands/<brand>/brand.md` — the file the brand page edits and every
 * agent reads. The blog derives its fields from it and never writes it:
 * a person edits it on the page, an agent edits it as a file.
 *
 * Campaigns and their seeds sit beside it, one file per record under
 * `campaigns/` and `campaign-seeds/`, keyed by the id the web app mints. One
 * file each so a write never clobbers the campaign being edited, which a single
 * array file would bring back under last-write-wins. Blogpost cards follow the
 * same rule under `cards/`, and are changed by merging into what is stored
 * (`updateBlogRecord`), since a card's agent and a person write the same one.
 *
 * Reads are best-effort throughout: a corrupt or vanished file is skipped, a
 * missing directory is an empty list, and nothing here throws on the read
 * path. Losing one campaign is a thinner board; an exception is a blank one.
 */

import {
  type BlogBrand,
  type BlogContext,
  type BlogFormats,
  BRANDS_DIR,
  brandForBlog,
  pickBrandDir,
} from "@decocms/shared/brand";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { retry, RetryError } from "@decocms/shared/std";
import { createHash } from "node:crypto";
import {
  type OrgFs,
  OrgFsConflictError,
  OrgFsNotFoundError,
  type WriteExpectation,
} from "./org-fs";
import type { OrgFsEntry } from "../storage/org-fs";

export const CAMPAIGNS_DIR = "campaigns";
export const CAMPAIGN_SEEDS_DIR = "campaign-seeds";
export const CARDS_DIR = "cards";

const BRAND_FILE = "brand.md";

/**
 * How many records one read returns.
 *
 * A ceiling rather than a page: nothing downstream paginates, and a board that
 * silently shows the first slice is worse than one that shows all it has. High
 * enough that no real brand reaches it, low enough that a pathological folder
 * cannot make a request read forever.
 */
const MAX_CAMPAIGNS = 500;
export const MAX_CAMPAIGN_SEEDS = 200;
const MAX_CARDS = 500;

/** The volume every path below is read from and written to. */
const BLOG_VOLUME = HOME_MOUNT_PATH;

/** `brands/<brand>`, inside the `home` volume. */
export function brandPath(brand: string): string {
  return `${BRANDS_DIR}/${brand}`;
}

type RecordDir =
  | typeof CAMPAIGNS_DIR
  | typeof CAMPAIGN_SEEDS_DIR
  | typeof CARDS_DIR;

export function recordPath(brand: string, dir: RecordDir, id: string): string {
  return `${brandPath(brand)}/${dir}/${id}.json`;
}

/**
 * The brand folder an organization's blog reads and writes, of the ones it
 * has — the same choice the brand page opens on.
 */
export async function resolveBrandDir(
  orgFs: OrgFs,
  orgSlug: string,
): Promise<string> {
  let entries: OrgFsEntry[] = [];
  try {
    entries = await orgFs.listDir(BLOG_VOLUME, BRANDS_DIR);
  } catch {
    // No brands folder yet: the org's own name is the one to create.
  }
  const dirs = entries
    .filter((entry) => entry.kind === "dir")
    .map((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1));
  return pickBrandDir(orgSlug, dirs);
}

/** One stored record and the id its filename carries. */
export interface BlogRecord {
  id: string;
  data: Record<string, unknown>;
}

/** Everything the blog reads, with the version each file was read at. */
export interface BlogState {
  /** The brand folder this was read from, `brands/<brand>`. */
  brandPath: string;
  /** Null until the brand has a guide. */
  brand: BlogBrand | null;
  context: BlogContext | null;
  formats: BlogFormats | null;
  campaigns: BlogRecord[];
  campaignSeeds: BlogRecord[];
  /**
   * `path -> contentHash` for every file read, so a caller can write back
   * conditionally. A file with no hash (written before hashes existed) is
   * absent here and its write goes unconditional.
   */
  versions: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The id a record file carries, or null when the name is not `<id>.json`. */
function idOfPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".json") ? base.slice(0, -".json".length) : null;
}

/** One file as text, or null for anything that went wrong reading it. */
async function readText(orgFs: OrgFs, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await orgFs.read(BLOG_VOLUME, path));
  } catch {
    return null;
  }
}

/** One JSON file, parsed, or null for anything that went wrong. */
async function readJson(
  orgFs: OrgFs,
  path: string,
): Promise<Record<string, unknown> | null> {
  const text = await readText(orgFs, path);
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Every `<id>.json` under one directory, bounded, corrupt files skipped. */
async function readRecords(
  orgFs: OrgFs,
  dir: string,
  max: number,
  versions: Record<string, string>,
): Promise<BlogRecord[]> {
  let entries: OrgFsEntry[];
  try {
    entries = await orgFs.listDir(BLOG_VOLUME, dir);
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.kind === "file" && entry.path.endsWith(".json"))
    .slice(0, max);

  const read = await Promise.all(
    files.map(async (entry) => {
      const id = idOfPath(entry.path);
      if (!id) return null;
      const data = await readJson(orgFs, entry.path);
      if (!data) return null;
      if (entry.contentHash) versions[entry.path] = entry.contentHash;
      return { id, data };
    }),
  );
  return read.filter((record): record is BlogRecord => record !== null);
}

/**
 * The blog's whole editorial state, from one brand folder.
 *
 * Never throws: a brand with no folder, no guide or no campaigns reads as
 * empty, which is exactly what a brand-new organization is.
 */
export async function readBlogState(
  orgFs: OrgFs,
  brand: string,
): Promise<BlogState> {
  const base = brandPath(brand);
  const guidePath = `${base}/${BRAND_FILE}`;
  const versions: Record<string, string> = {};

  let entries: OrgFsEntry[] = [];
  try {
    entries = await orgFs.listDir(BLOG_VOLUME, base);
  } catch {
    // A brand not created yet reads as empty.
  }
  const guideEntry = entries.find(
    (entry) => entry.kind === "file" && entry.path === guidePath,
  );

  const [guide, campaigns, campaignSeeds] = await Promise.all([
    guideEntry ? readText(orgFs, guidePath) : Promise.resolve(null),
    readRecords(orgFs, `${base}/${CAMPAIGNS_DIR}`, MAX_CAMPAIGNS, versions),
    readRecords(
      orgFs,
      `${base}/${CAMPAIGN_SEEDS_DIR}`,
      MAX_CAMPAIGN_SEEDS,
      versions,
    ),
  ]);

  if (guide !== null && guideEntry?.contentHash) {
    versions[guidePath] = guideEntry.contentHash;
  }
  const read = guide === null ? null : brandForBlog(guide, brand);

  return {
    brandPath: base,
    brand: read?.brand ?? null,
    context: read?.context ?? null,
    formats: read?.formats ?? null,
    campaigns,
    campaignSeeds,
    versions,
  };
}

/** What one write asks of the version it is replacing. */
export interface BlogWrite {
  path: string;
  data: Record<string, unknown>;
  expect?: WriteExpectation;
}

/**
 * Write files, failing the whole call on the first refusal.
 *
 * Deliberately not best-effort, unlike the read: the caller asked for every
 * write in the call and can retry. `OrgFsConflictError` travels out as itself
 * so the caller can tell "someone else wrote this" from "storage is broken".
 */
export async function writeBlogFiles(
  orgFs: OrgFs,
  actor: string,
  writes: BlogWrite[],
): Promise<OrgFsEntry[]> {
  const written: OrgFsEntry[] = [];
  for (const write of writes) {
    written.push(
      await orgFs.write(BLOG_VOLUME, write.path, JSON.stringify(write.data), {
        actor,
        contentType: "application/json",
        ...(write.expect ? { expect: write.expect } : {}),
      }),
    );
  }
  return written;
}

/**
 * Delete records by id. Best-effort per file: a record already gone is the
 * outcome the caller asked for, not a failure.
 */
export async function deleteBlogRecords(
  orgFs: OrgFs,
  brand: string,
  actor: string,
  dir: RecordDir,
  ids: string[],
): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await orgFs.delete(BLOG_VOLUME, recordPath(brand, dir, id), {
          actor,
        });
      } catch (err) {
        console.warn("[blog-state] could not delete a record", {
          dir,
          id,
          err,
        });
      }
    }),
  );
}

/** Every blogpost card in one brand folder, bounded, corrupt files skipped. */
export async function readBlogCards(
  orgFs: OrgFs,
  brand: string,
): Promise<BlogRecord[]> {
  return readRecords(orgFs, `${brandPath(brand)}/${CARDS_DIR}`, MAX_CARDS, {});
}

/** One record and the version of the bytes it was parsed from. */
export interface VersionedRecord {
  data: Record<string, unknown>;
  /** The content hash a conditional write expects, `sha256` of those bytes. */
  version: string;
}

/**
 * One record, or null when it is absent or unparseable.
 *
 * Unlike the reads above, this throws when storage fails: it is the first half
 * of a write, and a broken read taken for an absent record would answer "no
 * such card" for a card that is there.
 */
export async function readBlogRecord(
  orgFs: OrgFs,
  path: string,
): Promise<VersionedRecord | null> {
  let bytes: Uint8Array;
  try {
    bytes = await orgFs.read(BLOG_VOLUME, path);
  } catch (err) {
    if (err instanceof OrgFsNotFoundError) return null;
    throw err;
  }
  let data: Record<string, unknown> | null;
  try {
    data = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
  if (!data) return null;
  return { data, version: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Change one record and write it back, without losing a write that landed in
 * between.
 *
 * `change` gets the record as stored and returns what it becomes, or throws to
 * refuse. Every attempt re-reads, so it always judges the current record. With
 * `expect`, there is one attempt and a version that moved is the caller's
 * conflict. Without, a write landing between the read and this one costs a
 * re-read, up to three times: a card's agent and a person writing the same
 * card is the normal case, not a race one of them should lose.
 *
 * Two writes in the same instant can still both land, the second over the
 * first: `OrgFs.write` checks the version against the manifest row it read,
 * not atomically with its own write.
 */
export async function updateBlogRecord(
  orgFs: OrgFs,
  actor: string,
  path: string,
  change: (
    current: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  opts: { expect?: string } = {},
): Promise<{ data: Record<string, unknown>; entry: OrgFsEntry }> {
  const attempt = async () => {
    const current = await readBlogRecord(orgFs, path);
    if (!current) throw new OrgFsNotFoundError(`No such record: ${path}`);
    if (opts.expect && opts.expect !== current.version) {
      throw new OrgFsConflictError(`${path} changed since it was read`);
    }
    const data = await change(current.data);
    const entry = await orgFs.write(BLOG_VOLUME, path, JSON.stringify(data), {
      actor,
      contentType: "application/json",
      expect: { contentHash: current.version },
    });
    return { data, entry };
  };
  if (opts.expect) return attempt();
  try {
    return await retry(attempt, {
      maxAttempts: 3,
      minTimeout: 50,
      maxTimeout: 400,
      isRetriable: (err) => err instanceof OrgFsConflictError,
    });
  } catch (err) {
    throw err instanceof RetryError ? err.cause : err;
  }
}
