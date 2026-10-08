/**
 * Linking a project to its site in `org_sites` (`link`), so the hosted
 * ownership check (`ownedProjectSite`, which reads the link) works for it.
 *
 * The site id is public and immutable: a project is linked once, and a slug
 * never leaves its org (a deleted org's slug stays reserved). After its
 * project is deleted, the same org may link it to another of its projects. `org_sites` ownership
 * also lets an org mint asset-storage credentials for `<slug>/*` (`managed`
 * file configs), and the slug a project is created with is caller-chosen. So a
 * slug no org owns is claimed only when it isn't a deco.cx site (the deco
 * import claims those, after proving access) and no other org's project names
 * it. Nothing here ever takes a slug from another org or another project.
 */

import { type Kysely, sql } from "kysely";
import type { Database } from "@/storage/types";
import type { OrgSiteStoragePort } from "@/storage/ports";
import {
  OrgSiteConflictError,
  OrgSiteLinkError,
  type OrgSiteLinkErrorCode,
} from "@/storage/org-sites";
import { getDecoSupabaseConfig, supabaseGet } from "@/deco-legacy/supabase";
import { projectSite } from "./scope";

/** Why a project was not linked to the site it names. */
export type SiteClaimRefusal =
  /** Another org owns the slug (`owner`: its id). */
  | "other-org"
  /** No org owns it, but another org's project names it (`owner`: that org). */
  | "other-org-project"
  /** No org owns it, and deco.cx has a site by that name. */
  | "deco.cx"
  /** A deleted org's slug: reserved forever. */
  | "reserved"
  /** The slug is already another project's site. */
  | "linked-elsewhere"
  /** The project already has a different site. */
  | "project-has-other-slug"
  /** The project isn't one of this org's projects. */
  | "project-not-found"
  /** The org's row for the slug vanished between the claim and the link. */
  | "not-found";

export type SiteClaimOutcome =
  /** Linked now (the slug was claimed for the org first when nobody had it). */
  | { status: "linked"; slug: string }
  | { status: "already-linked"; slug: string }
  | {
      status: "refused";
      slug: string;
      reason: SiteClaimRefusal;
      owner?: string;
    };

export interface SiteClaimDeps {
  orgSites: Pick<
    OrgSiteStoragePort,
    "getBySlug" | "getByProject" | "claimSite" | "link"
  >;
  /** Whether deco.cx has a site by this name (see {@link decoSiteExists}). */
  isDecoSite: (slug: string) => Promise<boolean>;
  /** The id of another org with a project naming `slug`, or null. */
  otherOrgNamingSlug?: (
    slug: string,
    organizationId: string,
  ) => Promise<string | null>;
}

const LINK_REFUSALS: Record<OrgSiteLinkErrorCode, SiteClaimRefusal> = {
  not_found: "not-found",
  reserved: "reserved",
  not_owned: "other-org",
  linked_elsewhere: "linked-elsewhere",
  project_has_other_slug: "project-has-other-slug",
  project_not_found: "project-not-found",
  in_use: "linked-elsewhere",
};

/**
 * Makes `slug` the site of `projectId`, once: claims it for the org first when
 * no org owns it (and it is safe to), then links. Idempotent. `dryRun` answers
 * what would happen, writing nothing.
 */
export async function linkProjectSite(
  deps: SiteClaimDeps,
  input: {
    slug: string;
    organizationId: string;
    projectId: string;
    by: string;
    source: string;
    dryRun?: boolean;
  },
): Promise<SiteClaimOutcome> {
  const { slug, organizationId, projectId } = input;
  const refused = (
    reason: SiteClaimRefusal,
    owner?: string,
  ): SiteClaimOutcome => ({
    status: "refused",
    slug,
    reason,
    ...(owner ? { owner } : {}),
  });

  const current = await deps.orgSites.getByProject(projectId);
  if (current) {
    return current.slug === slug
      ? { status: "already-linked", slug }
      : refused("project-has-other-slug");
  }
  const row = await deps.orgSites.getBySlug(slug);
  if (row) {
    if (row.organizationId === null) return refused("reserved");
    if (row.organizationId !== organizationId) {
      return refused("other-org", row.organizationId);
    }
    if (row.projectId !== null) return refused("linked-elsewhere");
    // Unlinked: never used, or its project was deleted — the org's to link.
  } else {
    const other = await deps.otherOrgNamingSlug?.(slug, organizationId);
    if (other) return refused("other-org-project", other);
    if (await deps.isDecoSite(slug)) return refused("deco.cx");
    if (input.dryRun) return { status: "linked", slug };
    try {
      await deps.orgSites.claimSite({
        slug,
        organizationId,
        source: input.source,
        by: input.by,
      });
    } catch (error) {
      // Another org claimed it, or it became a tombstone, since the read.
      if (error instanceof OrgSiteConflictError) {
        return refused("other-org", error.ownerOrganizationId);
      }
      if (error instanceof OrgSiteLinkError) {
        return refused(LINK_REFUSALS[error.code]);
      }
      throw error;
    }
  }
  if (input.dryRun) return { status: "linked", slug };
  try {
    await deps.orgSites.link({
      slug,
      organizationId,
      projectId,
      by: input.by,
    });
    return { status: "linked", slug };
  } catch (error) {
    if (error instanceof OrgSiteLinkError) {
      return refused(LINK_REFUSALS[error.code]);
    }
    throw error;
  }
}

/**
 * The link made when a project is created or imported: its `siteSlug`, if it
 * has a valid one. Best-effort — logs and answers null instead of failing the
 * project's creation. A refused project keeps the slug unlinked (it can't
 * change), so it gets no hosted features.
 */
export async function claimProjectSite(
  deps: SiteClaimDeps,
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
    const outcome = await linkProjectSite(deps, {
      slug,
      organizationId: input.organizationId,
      projectId: input.projectId,
      by: input.by,
      source: "project-create",
    });
    if (outcome.status === "refused") {
      console.warn("hosted: project site not linked", {
        organizationId: input.organizationId,
        projectId: input.projectId,
        slug,
        reason: outcome.reason,
        owner: outcome.owner,
      });
    }
    return outcome;
  } catch (error) {
    console.error("hosted: project site link failed", {
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
  linked: SiteClaimCandidate[];
  alreadyLinked: SiteClaimCandidate[];
  refused: (SiteClaimCandidate & {
    reason: SiteClaimRefusal;
    owner?: string;
  })[];
  /**
   * Nobody is linked: an unowned slug that projects of more than one org name,
   * or a slug that several projects of one org name with none linked yet.
   */
  ambiguous: {
    slug: string;
    organizationIds: string[];
    projectIds: string[];
  }[];
  notV8: SiteClaimCandidate[];
  errors: (SiteClaimCandidate & { error: string })[];
}

/**
 * Links existing Blocks v8 projects to their sites. Safe to re-run: a link is
 * idempotent and never takes a slug another org or project has (reported as
 * `refused`). A slug is linked to nobody when it is ambiguous: unowned and
 * named by v8 projects of two orgs, or named by several projects of one org.
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
    linked: [],
    alreadyLinked: [],
    refused: [],
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
  // The backfill decides between projects itself, so the per-project
  // "another org names it" rule is replaced by the `ambiguous` one below.
  const linkDeps: SiteClaimDeps = {
    orgSites: deps.orgSites,
    isDecoSite: deps.isDecoSite,
  };
  const ambiguous = (named: SiteClaimCandidate[]) =>
    report.ambiguous.push({
      slug: named[0]!.slug,
      organizationIds: [...new Set(named.map((c) => c.organizationId))].sort(),
      projectIds: named.map((c) => c.projectId).sort(),
    });
  for (const [slug, named] of [...bySlug].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    let row: Awaited<ReturnType<SiteClaimDeps["orgSites"]["getBySlug"]>>;
    try {
      row = await deps.orgSites.getBySlug(slug);
    } catch (error) {
      for (const candidate of named) fail(candidate, error);
      continue;
    }
    const orgs = [...new Set(named.map((c) => c.organizationId))].sort();
    if (orgs.length > 1 && !row) {
      ambiguous(named);
      continue;
    }
    for (const organizationId of orgs) {
      const projects = named.filter((c) => c.organizationId === organizationId);
      // Several projects of one org name it: only an existing link decides.
      if (
        projects.length > 1 &&
        !projects.some((c) => c.projectId === row?.projectId)
      ) {
        ambiguous(projects);
        continue;
      }
      for (const candidate of projects) {
        try {
          const outcome = await linkProjectSite(linkDeps, {
            slug,
            organizationId,
            projectId: candidate.projectId,
            by: deps.by,
            source: "backfill",
            dryRun: deps.dryRun,
          });
          if (outcome.status === "linked") report.linked.push(candidate);
          else if (outcome.status === "already-linked") {
            report.alreadyLinked.push(candidate);
          } else {
            report.refused.push({
              ...candidate,
              reason: outcome.reason,
              ...(outcome.owner ? { owner: outcome.owner } : {}),
            });
          }
        } catch (error) {
          fail(candidate, error);
        }
      }
    }
  }
  return report;
}
