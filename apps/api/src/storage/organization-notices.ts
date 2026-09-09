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

  /**
   * Set a live notice only when the current notice belongs to the same source.
   *
   * Machine integrations use this instead of `setActive`: a finance sync may
   * refresh its own warning or escalate it to a block, but it must never replace
   * text an operator pinned manually. The conflict predicate makes that
   * ownership check atomic, including when a manual write races this one.
   * Returns null when another source owns the active notice.
   */
  async setActiveForSource(params: {
    organizationId: string;
    notice: OrgNoticeInput;
    source: string;
    by: string;
  }): Promise<OrganizationNotice | null> {
    const now = new Date();
    const { notice, source } = params;
    const row = await this.db
      .insertInto("organization_notices")
      .values({
        id: randomUUID(),
        organization_id: params.organizationId,
        severity: notice.severity,
        title: notice.title,
        message: notice.message,
        cta_label: notice.ctaLabel || null,
        cta_url: notice.ctaUrl || null,
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
            cta_label: notice.ctaLabel || null,
            cta_url: notice.ctaUrl || null,
            source,
            updated_by: params.by,
            updated_at: now,
          })
          .where("organization_notices.source", "=", source),
      )
      .returningAll()
      .executeTakeFirst();

    return row ? toEntity(row) : null;
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

  /** Resolve only a notice owned by `source`. */
  async resolveActiveForSource(params: {
    organizationId: string;
    source: string;
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
      .where("source", "=", params.source)
      .where("resolved_at", "is", null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }
}
