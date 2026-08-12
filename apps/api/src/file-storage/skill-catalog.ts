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
import type { StudioContext } from "../core/studio-context";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { OrgFs } from "./org-fs";
import { orgFsSandboxPath } from "./mount/provisioning";
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

/** Total SKILL.md reads per build — a backstop against a pathological tree. */
const MAX_SKILLS = 200;
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

/**
 * Detect skill folders directly under `(volume, base)`: list immediate child
 * dirs, batch-probe `<dir>/SKILL.md`, read + parse the hits. One listDir + one
 * filesExist + one read per skill. Best-effort — returns [] on any storage
 * error and skips individual unreadable skills. `budget` caps total reads.
 */
export async function detectSkills(
  fs: OrgFs,
  volume: string,
  base: string,
  budget: { remaining: number },
): Promise<DetectedSkill[]> {
  try {
    const dirs = (await fs.listDir(volume, base)).filter(
      (e) => e.kind === "dir",
    );
    if (dirs.length === 0) return [];
    const found = await fs.filesExist(
      volume,
      dirs.map((d) => `${d.path}/SKILL.md`),
    );
    const out: DetectedSkill[] = [];
    for (const d of dirs) {
      if (budget.remaining <= 0) break;
      if (!found.has(`${d.path}/SKILL.md`)) continue;
      budget.remaining -= 1;
      try {
        const bytes = await fs.read(volume, `${d.path}/SKILL.md`);
        const meta = parseSkillMd(new TextDecoder().decode(bytes));
        out.push({
          dirPath: d.path,
          name: meta.name ?? basename(d.path),
          description: meta.description,
        });
      } catch {
        // Skill dir without a readable SKILL.md (sync race, vanished file) —
        // skip it rather than fail the whole catalog.
      }
    }
    return out;
  } catch (err) {
    console.warn(`[skill-catalog] scan failed (${volume}:${base || "/"})`, err);
    return [];
  }
}

/** Public sets are org-independent (shared system scope); build once + cache. */
async function buildPublicEntries(
  ctx: StudioContext,
  budget: { remaining: number },
): Promise<SkillCatalogEntry[]> {
  if (publicCache && publicCache.expires > Date.now())
    return publicCache.entries;

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

/** Repo-sync skills: bounded probe of each synced volume's root. */
async function buildSyncedEntries(
  ctx: StudioContext,
  orgId: string,
  budget: { remaining: number },
): Promise<SkillCatalogEntry[]> {
  const volumes = await ctx.storage.orgRepoSyncs
    .listEnabledVolumes(orgId)
    .catch(() => [] as string[]);
  if (volumes.length === 0) return [];
  const fs = buildOrgFs(ctx, orgId);
  const entries: SkillCatalogEntry[] = [];
  for (const volume of volumes) {
    const detected = await detectSkills(fs, volume, "", budget);
    for (const s of detected) {
      entries.push({
        id: `repo/${volume}/${s.dirPath}`,
        name: s.name,
        description: s.description,
        source: `repo:${volume}`,
        sandboxPath: orgFsSandboxPath(volume, s.dirPath),
        volume,
        path: s.dirPath,
      });
    }
  }
  return entries;
}

/** Home skills: bounded probe of `org/home/*` and `org/home/skills/*`. */
async function buildHomeEntries(
  ctx: StudioContext,
  orgId: string,
  budget: { remaining: number },
): Promise<SkillCatalogEntry[]> {
  const home = buildOrgFs(ctx, orgId);
  const [top, nested] = await Promise.all([
    detectSkills(home, HOME_VOLUME, "", budget),
    detectSkills(home, HOME_VOLUME, "skills", budget),
  ]);
  return [...top, ...nested].map((s) => ({
    id: `home/${s.dirPath}`,
    name: s.name,
    description: s.description,
    source: "home",
    sandboxPath: orgFsSandboxPath(HOME_VOLUME, s.dirPath),
    volume: HOME_VOLUME,
    path: s.dirPath,
  }));
}

/**
 * The skills available to `orgId`'s agents: public sets + the org's home,
 * sorted deterministically (so the rendered block stays byte-stable and in the
 * cached prompt prefix). Never throws.
 */
export async function buildSkillCatalog(
  ctx: StudioContext,
  orgId: string,
): Promise<SkillCatalogEntry[]> {
  const budget = { remaining: MAX_SKILLS };
  const [pub, home, synced] = await Promise.all([
    buildPublicEntries(ctx, budget),
    buildHomeEntries(ctx, orgId, budget),
    buildSyncedEntries(ctx, orgId, budget),
  ]);
  return [...pub, ...home, ...synced].sort(
    (a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
  );
}
