/**
 * The blog's editorial state, in the organization's file library.
 *
 * Brand, writing rules, formats, campaigns and campaign seeds used to live as
 * blocks in the site's git decofile — under keys carrying no `__resolveType`,
 * so the rendered site ignored them. They were CMS state squatting in the repo,
 * and being in the repo made them branch-scoped: a campaign written on a
 * release branch did not exist on any other. None of that was wanted.
 *
 * Here instead, under the project's own folder in the `home` volume, which the
 * Library browses and a sandbox mounts read-write at
 * `/app/org/home/projects/<folder>/Blog/`. An agent reaching for what this
 * brand sounds like finds it by looking.
 *
 * Two shapes, for two different hazards:
 *
 *  - The three singletons are one file each and are what a person edits, so a
 *    write takes `expect` and a stale one is refused rather than landing.
 *  - Campaigns and seeds are one file per record, keyed by the id the web app
 *    already mints. The decofile split them for exactly this reason — "a write
 *    never clobbers the campaign being edited" — and a single array file would
 *    bring the clobber back under last-write-wins.
 *
 * Reads are best-effort throughout, after `agent-prompts.ts`: a corrupt or
 * vanished file is skipped, a missing directory is an empty list, and nothing
 * here throws on the read path. Losing one campaign is a thinner board; an
 * exception is a blank one.
 */

import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { projectFolderDir } from "@decocms/shared/organization/project-folder";
import type { OrgFs, WriteExpectation } from "./org-fs";
import type { OrgFsEntry } from "../storage/org-fs";

/** The project folder's blog subtree. Not in `PROJECT_SUBFOLDERS`: that would
 *  mint an empty `Blog/` in every project in the org, blog or not. The first
 *  write creates it — `OrgFs.write` makes the parents. */
const BLOG_DIR = "Blog";

export const CAMPAIGNS_DIR = "campaigns";
export const CAMPAIGN_SEEDS_DIR = "campaign-seeds";

/** The one singleton per thing a person edits. */
const BLOG_SINGLETON_FILES = {
  brand: "brand.json",
  context: "context.json",
  formats: "formats.json",
} as const;

export type BlogSingleton = keyof typeof BLOG_SINGLETON_FILES;

const BLOG_SINGLETONS = Object.keys(BLOG_SINGLETON_FILES) as BlogSingleton[];

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

/** Projects are identified by their folder, which the server pins on the row. */
export interface ProjectRef {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

/** `projects/<folder>/Blog`, inside the `home` volume. */
export function blogDir(project: ProjectRef): string {
  return `${projectFolderDir(project)}/${BLOG_DIR}`;
}

/** The volume every path below is read from and written to. */
const BLOG_VOLUME = HOME_MOUNT_PATH;

export function singletonPath(
  project: ProjectRef,
  which: BlogSingleton,
): string {
  return `${blogDir(project)}/${BLOG_SINGLETON_FILES[which]}`;
}

export function recordPath(
  project: ProjectRef,
  dir: typeof CAMPAIGNS_DIR | typeof CAMPAIGN_SEEDS_DIR,
  id: string,
): string {
  return `${blogDir(project)}/${dir}/${id}.json`;
}

/** One stored record and the id its filename carries. */
export interface BlogRecord {
  id: string;
  data: Record<string, unknown>;
}

/** Everything the blog reads, with the version each file was read at. */
export interface BlogState {
  brand: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  formats: Record<string, unknown> | null;
  campaigns: BlogRecord[];
  campaignSeeds: BlogRecord[];
  /**
   * `path -> contentHash` for every file read, so a caller can write back
   * conditionally. A file with no hash (written before hashes existed) is
   * absent here and its write goes unconditional.
   */
  versions: Record<string, string>;
}

const EMPTY_STATE: BlogState = {
  brand: null,
  context: null,
  formats: null,
  campaigns: [],
  campaignSeeds: [],
  versions: {},
};

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
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

/** One file, parsed, or null for anything that went wrong reading it. */
async function readJson(
  orgFs: OrgFs,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(decode(await orgFs.read(BLOG_VOLUME, path)));
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
 * The whole editorial state of one project's blog.
 *
 * Never throws: a project with no folder, no `Blog/` or no files at all reads
 * as empty, which is exactly what a brand-new site is.
 */
export async function readBlogState(
  orgFs: OrgFs,
  project: ProjectRef,
): Promise<BlogState> {
  const base = blogDir(project);
  const versions: Record<string, string> = {};

  let singletonEntries: OrgFsEntry[];
  try {
    singletonEntries = await orgFs.listDir(BLOG_VOLUME, base);
  } catch {
    return { ...EMPTY_STATE, versions };
  }
  const present = new Map(singletonEntries.map((e) => [e.path, e]));

  const [singletons, campaigns, campaignSeeds] = await Promise.all([
    Promise.all(
      BLOG_SINGLETONS.map(async (which) => {
        const path = singletonPath(project, which);
        const entry = present.get(path);
        if (!entry || entry.kind !== "file") return [which, null] as const;
        const data = await readJson(orgFs, path);
        if (data && entry.contentHash) versions[path] = entry.contentHash;
        return [which, data] as const;
      }),
    ),
    readRecords(orgFs, `${base}/${CAMPAIGNS_DIR}`, MAX_CAMPAIGNS, versions),
    readRecords(
      orgFs,
      `${base}/${CAMPAIGN_SEEDS_DIR}`,
      MAX_CAMPAIGN_SEEDS,
      versions,
    ),
  ]);

  const byName = Object.fromEntries(singletons) as Record<
    BlogSingleton,
    Record<string, unknown> | null
  >;

  return {
    brand: byName.brand,
    context: byName.context,
    formats: byName.formats,
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
 * Deliberately not best-effort, unlike the read: a half-applied edit is a brand
 * profile that disagrees with its own writing rules, and the caller can retry.
 * `OrgFsConflictError` travels out as itself so the caller can tell "someone
 * else wrote this" from "storage is broken".
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
  project: ProjectRef,
  actor: string,
  dir: typeof CAMPAIGNS_DIR | typeof CAMPAIGN_SEEDS_DIR,
  ids: string[],
): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await orgFs.delete(BLOG_VOLUME, recordPath(project, dir, id), {
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
