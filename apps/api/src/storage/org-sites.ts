import type { Kysely } from "kysely";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import type { Database, OrgSite } from "./types";
import type { OrgSiteStoragePort } from "./ports";

/**
 * Studio-local tenancy ownership: org ↔ globally-unique site slug. This is the
 * authorization source of truth for `managed` file configs — a config may mint
 * prefix-scoped STS credentials for a slug only if its org owns that slug here.
 */

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

type OrgSiteRow = {
  slug: string;
  organization_id: string;
  source: string;
  created_by: string;
  created_at: Date | string;
  updated_by: string;
  updated_at: Date | string;
};

function toEntity(row: OrgSiteRow): OrgSite {
  return {
    slug: row.slug,
    organizationId: row.organization_id,
    source: row.source,
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

    if (inserted) return toEntity(inserted as OrgSiteRow);

    // Slug already exists — only the owning org may re-claim (idempotent).
    const existing = await this.getBySlug(params.slug);
    if (!existing) {
      // Lost a race then the row vanished; surface as conflict rather than loop.
      throw new OrgSiteConflictError(params.slug, "unknown");
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

    return toEntity(updated as OrgSiteRow);
  }

  async getBySlug(slug: string): Promise<OrgSite | null> {
    const row = await this.db
      .selectFrom("org_sites")
      .selectAll()
      .where("slug", "=", slug)
      .executeTakeFirst();
    return row ? toEntity(row as OrgSiteRow) : null;
  }

  async listByOrg(organizationId: string): Promise<OrgSite[]> {
    const rows = await this.db
      .selectFrom("org_sites")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("slug", "asc")
      .execute();
    return rows.map((row) => toEntity(row as OrgSiteRow));
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
