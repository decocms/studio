/**
 * Which projects get the hosted Deco CMS, and the pieces a hosted request
 * needs. Hosted is for Blocks v8 sites on GitHub only: main's schema passes
 * `isV8Schema` (`@decocms/shared/blocks-major`), whatever the org. v7 sites
 * never reach it.
 */

import { isV8SchemaText, schemaGenPath } from "@decocms/shared/blocks-major";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { resolveBlockContents } from "@/decofile/read-decofile";
import { type RepoContentClient, requireBranchHead } from "@/git-providers";
import { createTtlLruCache } from "@/lib/ttl-lru-cache";
import type { KVStorage } from "@/storage/kv";
import type { OrgSiteStoragePort } from "@/storage/ports";
import { deliveryStore } from "./delivery-store";
import { createDraftStore, type DraftStore } from "./draft-store";

/**
 * The site id a project names in `metadata.siteSlug` (what it was created
 * with). Ownership is the `org_sites` link: see {@link ownedProjectSite}.
 */
export function projectSite(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const slug = metadata?.siteSlug;
  return typeof slug === "string" && isValidSiteSlug(slug) ? slug : null;
}

/**
 * The project's site id: the `org_sites` row linked to it, only when its own
 * organization owns that row. The link is set once, when the project is
 * created or imported (hosted/claim-site.ts, the deco import, the admin
 * backfill), and never changes, so every hosted write (delivery objects,
 * drafts, site tokens) keys on it rather than on `metadata.siteSlug`. A
 * project that isn't linked gets no hosted features.
 */
export async function ownedProjectSite(
  orgSites: Pick<OrgSiteStoragePort, "getByProject">,
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  const site = await orgSites.getByProject(projectId);
  return site && site.organizationId === organizationId ? site.slug : null;
}

/**
 * The answer for a Blocks v8 project that doesn't own its site id in
 * `org_sites` (a second project on the same repository, an import whose site
 * another project or org already claimed): 409 with this code, apart from an
 * unconfigured delivery bucket (503), so the editor can say what to do.
 */
export const SITE_NOT_OWNED = {
  error: "This site is linked to another project",
  code: "site_not_owned",
} as const;

/** The draft store over the delivery bucket, or null when none is configured. */
export function hostedDrafts(kv: KVStorage): DraftStore | null {
  const store = deliveryStore();
  return store ? createDraftStore({ kv, store }) : null;
}

/**
 * `isV8Schema`'s answer per schema blob. A blob is immutable, so an answer
 * never goes stale; keyed by repository too, so tenants never share entries.
 */
const v8ByBlob = createTtlLruCache<boolean>({
  ttlMs: 24 * 60 * 60_000,
  maxSize: 5_000,
});

/**
 * `isV8Schema`'s answer per (repository, site folder, commit). A commit is
 * immutable too, so a repeat check on an unchanged main is just the head read:
 * no tree read, no blob read.
 */
const v8ByCommit = createTtlLruCache<boolean>({
  ttlMs: 24 * 60 * 60_000,
  maxSize: 5_000,
});

/**
 * How long a hosted gate may reuse main's answer without reading main's head
 * again ({@link mainIsV8} with `recentIf`). A gate runs on every decofile
 * read and save, v7 sites included, so a v7 site pays one head read per
 * minute at most, and the editor's read of main's schema on open (`rpc`
 * `schema.get`) may be up to that stale; a main that changes mid-session is
 * caught by the `main_schema_changed` 409. A marker that disagrees is never
 * reused over.
 */
const MAIN_V8_RECENT_MS = 60_000;

/** The last answer per (repository, main branch, site folder). */
const v8ByBranch = createTtlLruCache<boolean>({
  ttlMs: MAIN_V8_RECENT_MS,
  maxSize: 5_000,
});

/**
 * Whether main's `.deco/schema.gen.json` is a Blocks v8 one (`isV8Schema`).
 * Cheap enough for every hosted request: main's head is an ETag-cached ref
 * read (an unchanged head is a free 304) and the answer is remembered per
 * head commit, so an unchanged main costs nothing else. A new head reads the
 * schema's entry from that commit's cached tree, and the answer is also
 * remembered per blob, so the schema itself is downloaded (through the blob
 * cache) only when it changes. With `recentIf`, an answer from the last
 * minute is reused without even the head read when it equals `recentIf`
 * (the hosted gates pass the project's marker): an answer another pod just
 * wrote to the marker disagrees with this pod's, so it is read again.
 */
export async function mainIsV8(
  client: RepoContentClient,
  packagePath: string | null,
  mainBranch: string,
  options: { recentIf?: boolean } = {},
): Promise<boolean> {
  const path = schemaGenPath(packagePath);
  const repo = `${client.repo.provider}:${client.repo.host}/${client.repo.path}`;
  const branchKey = `${repo}#${mainBranch}:${path}`;
  if (options.recentIf !== undefined) {
    const recent = v8ByBranch.get(branchKey);
    if (recent === options.recentIf) return recent;
  }
  const head = await requireBranchHead(client, mainBranch);
  const commitKey = `${repo}@${head}:${path}`;
  let isV8 = v8ByCommit.get(commitKey);
  if (isV8 === undefined) {
    isV8 = await schemaBlobIsV8(client, repo, head, path);
    v8ByCommit.set(commitKey, isV8);
  }
  v8ByBranch.set(branchKey, isV8);
  return isV8;
}

async function schemaBlobIsV8(
  client: RepoContentClient,
  repo: string,
  head: string,
  path: string,
): Promise<boolean> {
  const entry = (await client.getEntriesAtPaths(head, [path])).get(path);
  if (entry?.type !== "blob") return false;
  const key = `${repo}@${entry.sha}`;
  const cached = v8ByBlob.get(key);
  if (cached !== undefined) return cached;
  const [file] = await resolveBlockContents(client, [
    { stem: path, sha: entry.sha },
  ]);
  const isV8 = isV8SchemaText(file?.content);
  v8ByBlob.set(key, isV8);
  return isV8;
}
