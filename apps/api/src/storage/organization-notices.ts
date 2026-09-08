import type { Kysely, Selectable } from "kysely";
import { randomUUID } from "node:crypto";
import type {
  OrgNoticeInput,
  OrgNoticeSeverity,
} from "@decocms/shared/organization/notice";
import type {
  Database,
  OrganizationNotice,
  OrganizationNoticeTable,
} from "./types";

/**
 * The deployment-admin billing notice pinned on an organization. At most one
 * row per org is live (`resolved_at IS NULL`, enforced by a partial unique
 * index); resolving stamps the row instead of deleting it, so an org's notice
 * history survives.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toEntity(
  row: Selectable<OrganizationNoticeTable>,
): OrganizationNotice {
  return {
    id: row.id,
    organizationId: row.organization_id,
    severity: row.severity as OrgNoticeSeverity,
    title: row.title,
    message: row.message,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    source: row.source,
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
    resolvedBy: row.resolved_by,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

export class OrganizationNoticeStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** The live notice for one org, or null. The read behind the gate's cache. */
  async getActive(organizationId: string): Promise<OrganizationNotice | null> {
    const row = await this.db
      .selectFrom("organization_notices")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("resolved_at", "is", null)
      .executeTakeFirst();
    return row ? toEntity(row) : null;
  }

  /** The live notice for each of `organizationIds` — one query for a list page. */
  async getActiveForOrgs(
    organizationIds: string[],
  ): Promise<Map<string, OrganizationNotice>> {
    if (organizationIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("organization_notices")
      .selectAll()
      .where("organization_id", "in", organizationIds)
      .where("resolved_at", "is", null)
      .execute();
    return new Map(rows.map((row) => [row.organization_id, toEntity(row)]));
  }

  /**
   * Set the org's live notice, editing the existing one when there is one.
   * Escalating a warning to a block is this call with a different `severity`,
   * which keeps the org on a single notice row rather than stacking two.
   */
  async setActive(params: {
    organizationId: string;
    notice: OrgNoticeInput;
    source?: string;
    by: string;
  }): Promise<OrganizationNotice> {
    const now = new Date();
    const { notice } = params;
    const ctaLabel = notice.ctaLabel || null;
    const ctaUrl = notice.ctaUrl || null;
    const source = params.source ?? "manual";

    const row = await this.db
      .insertInto("organization_notices")
      .values({
        id: randomUUID(),
        organization_id: params.organizationId,
        severity: notice.severity,
        title: notice.title,
        message: notice.message,
        cta_label: ctaLabel,
        cta_url: ctaUrl,
        source,
        resolved_at: null,
        resolved_by: null,
        created_by: params.by,
        created_at: now,
        updated_by: params.by,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .column("organization_id")
          .where("resolved_at", "is", null)
          .doUpdateSet({
            severity: notice.severity,
            title: notice.title,
            message: notice.message,
            cta_label: ctaLabel,
            cta_url: ctaUrl,
            source,
            updated_by: params.by,
            updated_at: now,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toEntity(row);
  }

  /** Resolve the org's live notice. False when there was nothing pinned. */
  async resolveActive(params: {
    organizationId: string;
    by: string;
  }): Promise<boolean> {
    const now = new Date();
    const res = await this.db
      .updateTable("organization_notices")
      .set({
        resolved_at: now,
        resolved_by: params.by,
        updated_by: params.by,
        updated_at: now,
      })
      .where("organization_id", "=", params.organizationId)
      .where("resolved_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }
}
