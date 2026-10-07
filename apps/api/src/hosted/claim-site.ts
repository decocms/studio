/**
 * Claiming a project's site (`metadata.siteSlug`) for its organization in
 * `org_sites`, so the hosted ownership check (`ownedProjectSite`) never blocks
 * a legitimate project.
 *
 * `org_sites` ownership also lets an org mint asset-storage credentials for
 * `<slug>/*` (`managed` file configs), and `metadata.siteSlug` is free text a
 * member sets. So a slug is claimed only when no org owns it AND it isn't a
 * deco.cx site: a deco.cx site is claimed by the deco import, which proves
 * access to it first. Neither rule ever takes a slug from another org.
 */

import { type Kysely, sql } from "kysely";
import type { Database } from "@/storage/types";
import type { OrgSiteStoragePort } from "@/storage/ports";
import { OrgSiteConflictError } from "@/storage/org-sites";
import { getDecoSupabaseConfig, supabaseGet } from "@/deco-legacy/supabase";
import { projectSite } from "./scope";

export type SiteClaimOutcome =
  | { status: "claimed"; slug: string }
  | { status: "already-owned"; slug: string }
  /** `owner`: the owning org's id, or `"deco.cx"` for an unimported deco.cx site. */
  | { status: "conflict"; slug: string; owner: string };

export interface SiteClaimDeps {
  orgSites: Pick<OrgSiteStoragePort, "getBySlug" | "claimSite">;
  /** Whether deco.cx has a site by this name (see {@link decoSiteExists}). */
  isDecoSite: (slug: string) => Promise<boolean>;
}

/**
 * Claims `slug` for `organizationId` when nobody owns it and it isn't a
 * deco.cx site. Idempotent. `dryRun` answers what would happen, writing
 * nothing.
 */
export async function claimSiteSlug(
  deps: SiteClaimDeps,
  input: {
    slug: string;
    organizationId: string;
    by: string;
    source: string;
    dryRun?: boolean;
  },
): Promise<SiteClaimOutcome> {
  const { slug, organizationId } = input;
  const owner = await deps.orgSites.getBySlug(slug);
  if (owner) {
    return owner.organizationId === organizationId
      ? { status: "already-owned", slug }
      : { status: "conflict", slug, owner: owner.organizationId };
  }
  if (await deps.isDecoSite(slug)) {
    return { status: "conflict", slug, owner: "deco.cx" };
  }
  if (input.dryRun) return { status: "claimed", slug };
  try {
    await deps.orgSites.claimSite({
      slug,
      organizationId,
      source: input.source,
      by: input.by,
    });
    return { status: "claimed", slug };
  } catch (error) {
    // Another org claimed it between the read and the insert.
    if (error instanceof OrgSiteConflictError) {
      return { status: "conflict", slug, owner: error.ownerOrganizationId };
    }
    throw error;
  }
}

/**
 * The claim made when a project is created or imported: its `siteSlug`, if it
 * has a valid one. Best-effort — logs and answers null instead of failing the
 * project's creation.
 *
 * Like the backfill's `ambiguous` rule, an unowned slug that a project of
 * another org already names is not claimed (that org may hold assets under
 * it from before claims existed): it is reported as a conflict with that org.
 */
export async function claimProjectSite(
  deps: SiteClaimDeps & {
    /** The id of another org with a project naming `slug`, or null. */
    otherOrgNamingSlug: (
      slug: string,
      organizationId: string,
    ) => Promise<string | null>;
  },
  input: {
    organizationId: string;
    projectId: string;
    metadata: Record<string, unknown> | null | undefined;
    by: string;
  },
): Promise<SiteClaimOutcome | null> {
  const slug = projectSite(input.metadata);
  if (!slug) return null;
  try {
    const owner = await deps.orgSites.getBySlug(slug);
    const other = owner
      ? null
      : await deps.otherOrgNamingSlug(slug, input.organizationId);
    const outcome: SiteClaimOutcome = other
      ? { status: "conflict", slug, owner: other }
      : await claimSiteSlug(deps, {
          slug,
          organizationId: input.organizationId,
          by: input.by,
          source: "project-create",
        });
    if (outcome.status === "conflict") {
      console.warn("hosted: project site is owned elsewhere; not claimed", {
        organizationId: input.organizationId,
        projectId: input.projectId,
        slug,
        owner: outcome.owner,
      });
    }
    return outcome;
  } catch (error) {
    console.error("hosted: project site claim failed", {
      organizationId: input.organizationId,
      projectId: input.projectId,
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Whether deco.cx's admin has a site named `slug`. False on a deployment with
 * no deco.cx Supabase (self-host: there is no deco.cx site to protect). Throws
 * when the lookup fails or takes longer than `timeoutMs`, so a claim fails
 * closed (and project creation is never held up by deco.cx).
 */
export async function decoSiteExists(
  slug: string,
  timeoutMs = DECO_SITE_LOOKUP_TIMEOUT_MS,
): Promise<boolean> {
  const config = getDecoSupabaseConfig();
  if (!config) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("deco.cx site lookup timed out")),
      timeoutMs,
    );
  });
  try {
    const sites = await Promise.race([
      supabaseGet<{ name: string }>(
        config.supabaseUrl,
        config.serviceKey,
        `sites?name=eq.${encodeURIComponent(slug)}&select=name&limit=1`,
      ),
      timeout,
    ]);
    return sites.length > 0;
  } finally {
    clearTimeout(timer);
  }
}

const DECO_SITE_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * `otherOrgNamingSlug` over the `connections` table: the id of an org other
 * than `organizationId` with a project (VIRTUAL connection) whose
 * `metadata.siteSlug` is `slug`. `metadata` is JSON in a text column, so a
 * LIKE narrows the rows and the match is made on the parsed value.
 */
export function otherOrgNamingSlugFromDb(db: Kysely<Database>) {
  return async (slug: string, organizationId: string) => {
    const pattern = `%${slug.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = await db
      .selectFrom("connections")
      .select(["organization_id", "metadata"])
      .where("connection_type", "=", "VIRTUAL")
      .where("organization_id", "<>", organizationId)
      .where(sql<string>`metadata::text`, "like", pattern)
      .execute();
    for (const row of rows) {
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata =
          typeof row.metadata === "string"
            ? (JSON.parse(row.metadata) as Record<string, unknown>)
            : (row.metadata as Record<string, unknown> | null);
      } catch {
        continue;
      }
      if (projectSite(metadata) === slug) return row.organization_id;
    }
    return null;
  };
}

/** A project that names a site, for the backfill. */
export interface SiteClaimCandidate {
  organizationId: string;
  projectId: string;
  slug: string;
}

export interface SiteClaimBackfillReport {
  dryRun: boolean;
  claimed: SiteClaimCandidate[];
  alreadyOwned: SiteClaimCandidate[];
  conflicts: (SiteClaimCandidate & { owner: string })[];
  /** Unclaimed slugs that projects of more than one org name: none is claimed. */
  ambiguous: { slug: string; organizationIds: string[] }[];
  notV8: SiteClaimCandidate[];
  errors: (SiteClaimCandidate & { error: string })[];
}

/**
 * Claims the sites of existing Blocks v8 projects. Safe to re-run: a claim is
 * idempotent and never takes a slug another org owns (reported as a
 * conflict). A slug that v8 projects of two orgs name is claimed for neither
 * (`ambiguous`), unless one of them already owns it.
 */
export async function backfillSiteClaims(
  deps: SiteClaimDeps & {
    candidates: SiteClaimCandidate[];
    /** Whether the project's main branch is a Blocks v8 site. */
    isV8: (candidate: SiteClaimCandidate) => Promise<boolean>;
    by: string;
    dryRun: boolean;
  },
): Promise<SiteClaimBackfillReport> {
  const report: SiteClaimBackfillReport = {
    dryRun: deps.dryRun,
    claimed: [],
    alreadyOwned: [],
    conflicts: [],
    ambiguous: [],
    notV8: [],
    errors: [],
  };
  const fail = (candidate: SiteClaimCandidate, error: unknown) =>
    report.errors.push({
      ...candidate,
      error: error instanceof Error ? error.message : String(error),
    });

  const v8: SiteClaimCandidate[] = [];
  for (const candidate of deps.candidates) {
    try {
      if (await deps.isV8(candidate)) v8.push(candidate);
      else report.notV8.push(candidate);
    } catch (error) {
      fail(candidate, error);
    }
  }

  const bySlug = new Map<string, SiteClaimCandidate[]>();
  for (const candidate of v8) {
    bySlug.set(candidate.slug, [
      ...(bySlug.get(candidate.slug) ?? []),
      candidate,
    ]);
  }
  for (const [slug, named] of [...bySlug].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const orgs = [...new Set(named.map((c) => c.organizationId))].sort();
    if (orgs.length > 1) {
      // Report owned slugs as usual; leave only a free one unclaimed.
      const owner = await deps.orgSites.getBySlug(slug).catch(() => null);
      if (!owner) {
        report.ambiguous.push({ slug, organizationIds: orgs });
        continue;
      }
    }
    // One claim per org; every project of that org shares its outcome.
    for (const organizationId of orgs) {
      const projects = named.filter((c) => c.organizationId === organizationId);
      try {
        const outcome = await claimSiteSlug(deps, {
          slug,
          organizationId,
          by: deps.by,
          source: "backfill",
          dryRun: deps.dryRun,
        });
        for (const candidate of projects) {
          if (outcome.status === "claimed") report.claimed.push(candidate);
          else if (outcome.status === "already-owned") {
            report.alreadyOwned.push(candidate);
          } else report.conflicts.push({ ...candidate, owner: outcome.owner });
        }
      } catch (error) {
        for (const candidate of projects) fail(candidate, error);
      }
    }
  }
  return report;
}
