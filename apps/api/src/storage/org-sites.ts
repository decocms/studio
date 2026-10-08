import { type Kysely, type Selectable, sql } from "kysely";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import type { Database, OrgSite, OrgSiteTable } from "./types";
import type { OrgSiteStoragePort } from "./ports";

/**
 * Studio-local tenancy ownership: org ↔ globally-unique site slug. This is the
 * authorization source of truth for `managed` file configs — a config may mint
 * prefix-scoped STS credentials for a slug only if its org owns that slug here.
 */

/**
 * The site id (slug) is public — CDN paths, site tokens, telemetry and asset
 * URLs carry it — and tokens can't be revoked. So once a project uses a slug
 * (`linked_at` set) it is tied to that org for good: it can't be released,
 * moved to another org, or relinked to a project elsewhere. A row whose org was
 * deleted (`organization_id` NULL) is a tombstone nobody can claim.
 */
const SITE_ID_IMMUTABLE_MESSAGE =
  "The site id can't change: CDN paths, tokens and asset URLs use it.";

/** A write that would change (or clear) a project's site slug once it has one. */
export class SiteSlugImmutableError extends Error {
  readonly code = "SITE_SLUG_IMMUTABLE";
  constructor() {
    super(SITE_ID_IMMUTABLE_MESSAGE);
    this.name = "SiteSlugImmutableError";
  }
}

export type OrgSiteLinkErrorCode =
  /** No `org_sites` row for the slug. */
  | "not_found"
  /** Tombstone: its org was deleted; the slug is reserved forever. */
  | "reserved"
  /** Another org owns the slug. */
  | "not_owned"
  /** The slug is the site of another project. */
  | "linked_elsewhere"
  /** The project already has a different site. */
  | "project_has_other_slug"
  /** The project isn't one of this org's projects. */
  | "project_not_found"
  /** The slug has been used by a project, so it can't be released or moved. */
  | "in_use";

const LINK_ERROR_MESSAGES: Record<OrgSiteLinkErrorCode, string> = {
  not_found: "This site id isn't registered for the organization.",
  reserved:
    "This site id belonged to a deleted organization and stays reserved.",
  not_owned: "This site id belongs to another organization.",
  linked_elsewhere: "This site id is already the site of another project.",
  project_has_other_slug: `This project already has a site id. ${SITE_ID_IMMUTABLE_MESSAGE}`,
  project_not_found: "Project not found in this organization.",
  in_use: `This site id has been used by a project, so it can't be released or moved. ${SITE_ID_IMMUTABLE_MESSAGE}`,
};

/** A link, claim, release or move the slug's lifecycle rules refuse. */
export class OrgSiteLinkError extends Error {
  constructor(
    public readonly code: OrgSiteLinkErrorCode,
    public readonly slug: string,
  ) {
    super(LINK_ERROR_MESSAGES[code]);
    this.name = "OrgSiteLinkError";
  }
}

/** Thrown when a slug is already claimed by a different organization. */
export class OrgSiteConflictError extends Error {
  constructor(
    public readonly slug: string,
    public readonly ownerOrganizationId: string,
  ) {
    super(`Site slug "${slug}" is already owned by another organization`);
    this.name = "OrgSiteConflictError";
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toEntity(row: Selectable<OrgSiteTable>): OrgSite {
  return {
    slug: row.slug,
    organizationId: row.organization_id,
    source: row.source,
    projectId: row.project_id,
    linkedAt: row.linked_at ? toIso(row.linked_at) : null,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

export class OrgSiteStorage implements OrgSiteStoragePort {
  constructor(private readonly db: Kysely<Database>) {}

  async claimSite(params: {
    slug: string;
    organizationId: string;
    source?: string;
    by: string;
  }): Promise<OrgSite> {
    if (!isValidSiteSlug(params.slug)) {
      throw new Error(
        `Invalid site slug "${params.slug}" — must be 1-60 chars of lowercase letters, digits, or hyphens, starting with a letter or digit`,
      );
    }
    const now = new Date();

    // Atomic insert; on slug conflict do nothing so we can detect ownership.
    const inserted = await this.db
      .insertInto("org_sites")
      .values({
        slug: params.slug,
        organization_id: params.organizationId,
        source: params.source ?? "deco-import",
        created_by: params.by,
        created_at: now,
        updated_by: params.by,
        updated_at: now,
      })
      .onConflict((oc) => oc.column("slug").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) return toEntity(inserted);

    // Slug already exists — only the owning org may re-claim (idempotent).
    const existing = await this.getBySlug(params.slug);
    if (!existing) {
      // Lost a race then the row vanished; surface as conflict rather than loop.
      throw new OrgSiteConflictError(params.slug, "unknown");
    }
    if (existing.organizationId === null) {
      throw new OrgSiteLinkError("reserved", params.slug);
    }
    if (existing.organizationId !== params.organizationId) {
      throw new OrgSiteConflictError(params.slug, existing.organizationId);
    }

    const updated = await this.db
      .updateTable("org_sites")
      .set({
        source: params.source ?? existing.source,
        updated_by: params.by,
        updated_at: now,
      })
      .where("slug", "=", params.slug)
      .where("organization_id", "=", params.organizationId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toEntity(updated);
  }

  async reassignSite(params: {
    slug: string;
    organizationId: string;
    source?: string;
    by: string;
  }): Promise<OrgSite> {
    if (!isValidSiteSlug(params.slug)) {
      throw new Error(
        `Invalid site slug "${params.slug}" — must be 1-60 chars of lowercase letters, digits, or hyphens, starting with a letter or digit`,
      );
    }
    const now = new Date();
    // Deployment-admin override: take the slug from whatever org owns it —
    // unless it is a tombstone or a project has used it (never reused).
    const row = await this.db
      .insertInto("org_sites")
      .values({
        slug: params.slug,
        organization_id: params.organizationId,
        source: params.source ?? "manual",
        created_by: params.by,
        created_at: now,
        updated_by: params.by,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .column("slug")
          .doUpdateSet({
            organization_id: params.organizationId,
            source: params.source ?? "manual",
            updated_by: params.by,
            updated_at: now,
          })
          .where("org_sites.organization_id", "is not", null)
          .where("org_sites.linked_at", "is", null),
      )
      .returningAll()
      .executeTakeFirst();
    if (row) return toEntity(row);

    const existing = await this.getBySlug(params.slug);
    if (existing?.organizationId === null) {
      throw new OrgSiteLinkError("reserved", params.slug);
    }
    throw new OrgSiteLinkError("in_use", params.slug);
  }

  async releaseSite(slug: string, organizationId: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("org_sites")
      .where("slug", "=", slug)
      .where("organization_id", "=", organizationId)
      .where("linked_at", "is", null)
      .executeTakeFirst();
    if (Number(res.numDeletedRows ?? 0n) > 0) return true;
    if (await this.isOwnedBy(slug, organizationId)) {
      throw new OrgSiteLinkError("in_use", slug);
    }
    return false;
  }

  async getByProject(projectId: string): Promise<OrgSite | null> {
    const row = await this.db
      .selectFrom("org_sites")
      .selectAll()
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return row ? toEntity(row) : null;
  }

  async link(params: {
    slug: string;
    organizationId: string;
    projectId: string;
    by: string;
  }): Promise<OrgSite> {
    const { slug, organizationId, projectId, by } = params;
    const existing = await this.getBySlug(slug);
    if (!existing) throw new OrgSiteLinkError("not_found", slug);
    if (existing.organizationId === null) {
      throw new OrgSiteLinkError("reserved", slug);
    }
    if (existing.organizationId !== organizationId) {
      throw new OrgSiteLinkError("not_owned", slug);
    }
    if (existing.projectId === projectId) return existing;
    if (existing.projectId !== null) {
      throw new OrgSiteLinkError("linked_elsewhere", slug);
    }

    const project = await this.db
      .selectFrom("connections")
      .select("id")
      .where("id", "=", projectId)
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();
    if (!project) throw new OrgSiteLinkError("project_not_found", slug);

    const current = await this.getByProject(projectId);
    if (current && current.slug !== slug) {
      throw new OrgSiteLinkError("project_has_other_slug", slug);
    }

    const now = new Date();
    let row: Selectable<OrgSiteTable> | undefined;
    try {
      row = await this.db
        .updateTable("org_sites")
        .set({
          project_id: projectId,
          linked_at: sql<Date>`coalesce(linked_at, now())`,
          updated_by: by,
          updated_at: now,
        })
        .where("slug", "=", slug)
        .where("organization_id", "=", organizationId)
        .where("project_id", "is", null)
        .returningAll()
        .executeTakeFirst();
    } catch (error) {
      // org_sites_project_id_uq: a concurrent link gave the project a site.
      if ((error as { code?: string }).code === "23505") {
        throw new OrgSiteLinkError("project_has_other_slug", slug);
      }
      throw error;
    }
    if (row) return toEntity(row);

    // Lost a race: re-read for the precise reason.
    const after = await this.getBySlug(slug);
    if (after?.projectId === projectId) return after;
    if (!after) throw new OrgSiteLinkError("not_found", slug);
    if (after.organizationId === null) {
      throw new OrgSiteLinkError("reserved", slug);
    }
    if (after.organizationId !== organizationId) {
      throw new OrgSiteLinkError("not_owned", slug);
    }
    throw new OrgSiteLinkError("linked_elsewhere", slug);
  }

  async getBySlug(slug: string): Promise<OrgSite | null> {
    const row = await this.db
      .selectFrom("org_sites")
      .selectAll()
      .where("slug", "=", slug)
      .executeTakeFirst();
    return row ? toEntity(row) : null;
  }

  async listByOrg(organizationId: string): Promise<OrgSite[]> {
    const rows = await this.db
      .selectFrom("org_sites")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("slug", "asc")
      .execute();
    return rows.map((row) => toEntity(row));
  }

  async isOwnedBy(slug: string, organizationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("org_sites")
      .select("slug")
      .where("slug", "=", slug)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return !!row;
  }
}
