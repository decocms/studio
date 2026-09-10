/**
 * Skill catalog — enumerates the skills available to an org's agents so they
 * can be surfaced up front (the `<available-skills>` block) for Claude-Code
 * style progressive discovery. Reads the same `SKILL.md` folders the sandbox
 * mounts: the shared read-only public sets (`org/public/<set>/`) plus the
 * org's own home volume (`org/home/`).
 *
 * Each entry carries a collision-free `id` (`<set>/<dir>` for public,
 * `home/<dir>` for home) that doubles as the `skill` tool's argument and maps
 * deterministically back to a sandbox path.
 *
 * Cheap and defensive: bounded probes (no recursive home scan), best-effort
 * per-file reads, never throws. The public portion is org-independent and
 * cached process-wide; the home portion is two batch probes per call.
 */

import { parseSkillMd } from "@/harnesses/lib/skills/skill-md";
import { mapWithConcurrency } from "@/tools/connection/map-with-concurrency";
import type { StudioContext } from "../core/studio-context";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { OrgFs } from "./org-fs";
import { orgFsSandboxPath } from "./mount/provisioning";
import {
  getSkillCatalogCache,
  recordSkillCatalogMiss,
} from "./skill-catalog-cache";
import {
  buildPublicOrgFs,
  getPublicSets,
  publicVolumeForSet,
} from "./public-sets";

export interface SkillCatalogEntry {
  /** Resolvable, collision-free id (`core/slides`, `home/skills/foo`). */
  id: string;
  /** Display name (frontmatter `name`, falling back to the dir basename). */
  name: string;
  description: string | null;
  /** Provenance shown to the model (`public:<set>` or `home`). */
  source: string;
  /** Sandbox path of the skill folder (e.g. `org/public/core/slides`). */
  sandboxPath: string;
  /** OrgFs volume the skill lives on (`home` or `public-<set>`). */
  volume: string;
  /** Volume-relative dir path (e.g. `skills/foo`) — used to attach as agent knowledge. */
  path: string;
}

/**
 * SKILL.md reads per build across the org's OWN volumes (home + synced repos)
 * — a backstop against a pathological tenant tree.
 *
 * Public sets carry their own budget below rather than sharing this one: they
 * are a fixed deployment-level set behind a process cache, so charging them
 * here made a tenant's cap depend on whether that cache happened to be warm.
 */
const MAX_SKILLS = 200;
/** The same backstop for the deployment's public sets. */
const MAX_PUBLIC_SKILLS = 200;
/**
 * Ceiling on SKILL.md reads in flight at once. The reads are issued together
 * for latency, but a wide org (or several rebuilding at once) should not turn
 * that into an unbounded burst against the storage client.
 */
const MAX_CONCURRENT_READS = 16;
/** Public sets are global + change only on the ~10-min sync; cache process-wide. */
const PUBLIC_TTL_MS = 5 * 60_000;
const HOME_VOLUME = "home";

let publicCache: { entries: SkillCatalogEntry[]; expires: number } | null =
  null;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** A skill folder detected under a volume, with its parsed metadata. */
export interface DetectedSkill {
  /** Volume-relative dir path (e.g. `slides`, `skills/foo`). */
  dirPath: string;
  /** Frontmatter `name`, falling back to the dir basename. */
  name: string;
  description: string | null;
}

/** One claimed skill folder, awaiting its `SKILL.md` read. */
interface SkillDir {
  volume: string;
  dirPath: string;
}

/**
 * Immediate child dirs of `(volume, base)` that contain a `SKILL.md`, sorted
 * by path. One listDir + one filesExist and no per-skill reads, so this is
 * cheap enough to run for every scope up front — before the budget decides
 * which of them can afford to be read. Best-effort: [] on any storage error.
 */
async function probeSkillDirs(
  fs: OrgFs,
  volume: string,
  base: string,
): Promise<string[]> {
  try {
    const dirs = (await fs.listDir(volume, base)).filter(
      (e) => e.kind === "dir",
    );
    if (dirs.length === 0) return [];
    const found = await fs.filesExist(
      volume,
      dirs.map((d) => `${d.path}/SKILL.md`),
    );
    // Sorted, not listing order: this is the order the budget is spent in.
    return dirs
      .map((d) => d.path)
      .filter((path) => found.has(`${path}/SKILL.md`))
      .toSorted();
  } catch (err) {
    console.warn(`[skill-catalog] scan failed (${volume}:${base || "/"})`, err);
    return [];
  }
}

/**
 * Read + parse every claimed `SKILL.md`, at most {@link MAX_CONCURRENT_READS}
 * in flight. Bounded rather than a plain `Promise.all`: a miss can claim up to
 * `MAX_SKILLS` folders, and concurrent misses across orgs multiply that into
 * one burst against the storage client. Results keep `dirs` order; an
 * individual unreadable skill is skipped, never fatal.
 */
async function readSkills(
  fs: OrgFs,
  dirs: SkillDir[],
): Promise<Array<SkillDir & DetectedSkill>> {
  const out = new Array<(SkillDir & DetectedSkill) | null>(dirs.length).fill(
    null,
  );
  await mapWithConcurrency(
    dirs.map((dir, index) => ({ dir, index })),
    MAX_CONCURRENT_READS,
    async ({ dir, index }) => {
      try {
        const bytes = await fs.read(dir.volume, `${dir.dirPath}/SKILL.md`);
        const meta = parseSkillMd(new TextDecoder().decode(bytes));
        out[index] = {
          ...dir,
          name: meta.name ?? basename(dir.dirPath),
          description: meta.description,
        };
      } catch {
        // Skill dir without a readable SKILL.md (sync race, vanished file) —
        // skip it rather than fail the whole catalog.
      }
    },
  );
  return out.filter((s) => s !== null);
}

/**
 * Detect skill folders directly under `(volume, base)`: probe, claim what the
 * budget allows, read + parse. Best-effort — returns [] on any storage error
 * and skips individual unreadable skills.
 *
 * The claim is a slice taken before the first read: with the reads issued
 * together there is no longer a decrement between them to serialize on, so
 * two concurrent scans sharing a budget would otherwise both see the same
 * remaining count.
 */
export async function detectSkills(
  fs: OrgFs,
  volume: string,
  base: string,
  budget: { remaining: number },
): Promise<DetectedSkill[]> {
  const dirPaths = await probeSkillDirs(fs, volume, base);
  const claimed = dirPaths.slice(0, Math.max(0, budget.remaining));
  budget.remaining -= claimed.length;
  const read = await readSkills(
    fs,
    claimed.map((dirPath) => ({ volume, dirPath })),
  );
  // Drop the volume `readSkills` threads through for the multi-volume caller —
  // a single-volume scan already knows it, and leaking it widens the shape.
  return read.map(({ dirPath, name, description }) => ({
    dirPath,
    name,
    description,
  }));
}

/** Public sets are org-independent (shared system scope); build once + cache. */
async function buildPublicEntries(
  ctx: StudioContext,
): Promise<SkillCatalogEntry[]> {
  if (publicCache && publicCache.expires > Date.now())
    return publicCache.entries;

  // Sets are walked in `getPublicSets()` order so an over-budget deployment
  // truncates the same way every time.
  const budget = { remaining: MAX_PUBLIC_SKILLS };
  const pub = buildPublicOrgFs(ctx);
  const entries: SkillCatalogEntry[] = [];
  for (const { set } of getPublicSets()) {
    const volume = publicVolumeForSet(set);
    const detected = await detectSkills(pub, volume, "", budget);
    for (const s of detected) {
      entries.push({
        id: `${set}/${s.dirPath}`,
        name: s.name,
        description: s.description,
        source: `public:${set}`,
        sandboxPath: orgFsSandboxPath(volume, s.dirPath),
        volume,
        path: s.dirPath,
      });
    }
  }
  // Only cache a non-empty result. `detectSkills` swallows transient storage
  // errors into `[]`; caching that (the cache is global) would suppress public
  // skills for EVERY org until the TTL expires. An empty result also covers the
  // pre-first-sync cold-boot window — re-probe until the set is populated.
  if (entries.length > 0) {
    publicCache = { entries, expires: Date.now() + PUBLIC_TTL_MS };
  }
  return entries;
}

/** Build a per-org OrgFs bound to the org's keyspace (mirrors rebindOrgScope). */
function buildOrgFs(ctx: StudioContext, orgId: string): OrgFs {
  const s3Service = getObjectStorageS3Service();
  const storage = s3Service
    ? createBoundObjectStorage(s3Service, orgId)
    : new DevObjectStorage(orgId, ctx.baseUrl);
  return new OrgFs(storage, ctx.storage.orgFsEntries, orgId);
}

/**
 * The org's own skills: `home/*`, `home/skills/*`, and the root of every
 * enabled synced repo volume.
 *
 * All scopes are probed together, then claimed in a FIXED scope order, then
 * read together. The fixed order is what makes an over-budget tree truncate to
 * the same set on every build — spending the budget in whichever order the
 * storage calls happened to return let two builds of one org expose different
 * repos, and the catalog is supposed to be byte-stable for the prompt prefix.
 */
async function buildOrgEntries(
  ctx: StudioContext,
  orgId: string,
): Promise<SkillCatalogEntry[]> {
  const volumes = (
    await ctx.storage.orgRepoSyncs
      .listEnabledVolumes(orgId)
      .catch(() => [] as string[])
  ).toSorted(); // the query promises no order; the claim order has to be ours

  const fs = buildOrgFs(ctx, orgId);
  const scopes = [
    { volume: HOME_VOLUME, base: "" },
    { volume: HOME_VOLUME, base: "skills" },
    ...volumes.map((volume) => ({ volume, base: "" })),
  ];

  const probed = await Promise.all(
    scopes.map((s) => probeSkillDirs(fs, s.volume, s.base)),
  );

  let remaining = MAX_SKILLS;
  const claimed: SkillDir[] = [];
  for (const [index, dirPaths] of probed.entries()) {
    const take = dirPaths.slice(0, remaining);
    remaining -= take.length;
    for (const dirPath of take) {
      claimed.push({ volume: scopes[index]!.volume, dirPath });
    }
  }

  return (await readSkills(fs, claimed)).map((s) =>
    s.volume === HOME_VOLUME
      ? {
          id: `home/${s.dirPath}`,
          name: s.name,
          description: s.description,
          source: "home",
          sandboxPath: orgFsSandboxPath(HOME_VOLUME, s.dirPath),
          volume: HOME_VOLUME,
          path: s.dirPath,
        }
      : {
          id: `repo/${s.volume}/${s.dirPath}`,
          name: s.name,
          description: s.description,
          source: `repo:${s.volume}`,
          sandboxPath: orgFsSandboxPath(s.volume, s.dirPath),
          volume: s.volume,
          path: s.dirPath,
        },
  );
}

/**
 * The skills available to `orgId`'s agents: public sets + the org's home,
 * sorted deterministically (so the rendered block stays byte-stable and in the
 * cached prompt prefix). Never throws.
 *
 * Served from the cross-replica cache when one is warm — see
 * {@link ./skill-catalog-cache.ts}. An empty build is cached like any other:
 * an org with no skills is a real answer, and re-scanning every volume to
 * re-learn it is the expensive case, not the cheap one.
 */
export async function buildSkillCatalog(
  ctx: StudioContext,
  orgId: string,
): Promise<SkillCatalogEntry[]> {
  const cache = getSkillCatalogCache();
  const cached = (await cache?.get(orgId)) ?? { catalog: null };
  if (cached.catalog) return cached.catalog;
  recordSkillCatalogMiss();

  const [pub, own] = await Promise.all([
    buildPublicEntries(ctx),
    buildOrgEntries(ctx, orgId),
  ]);
  const catalog = [...pub, ...own].sort(
    (a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
  );
  // Not awaited: the caller already has its answer, and a lost publish only
  // costs the next reader a rebuild. Carries the revision the miss was read
  // at, so a write that landed mid-build wins over this now-stale result.
  cache?.set(orgId, catalog, cached.revision).catch(() => {});
  return catalog;
}
