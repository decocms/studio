/**
 * Reports Storage Implementation
 *
 * Handles storage operations for automated reports (REPORTS_BINDING).
 * Reports are organization-scoped and stored in the Mesh database.
 */

import type { Kysely } from "kysely";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import type {
  Database,
  Report,
  ReportLifecycleStatus,
  ReportSection,
  ReportStatus,
} from "./types";

// ============================================================================
// Reports Storage Interface
// ============================================================================

export interface ReportsStorage {
  list(
    organizationId: string,
    filters?: { category?: string; status?: ReportStatus },
  ): Promise<Report[]>;

  get(id: string, organizationId: string): Promise<Report | null>;

  upsert(
    organizationId: string,
    data: Omit<Report, "updatedAt"> & { id?: string },
  ): Promise<Report>;

  updateLifecycleStatus(
    id: string,
    organizationId: string,
    status: ReportLifecycleStatus,
  ): Promise<{ success: boolean }>;
}

// ============================================================================
// Reports Storage Implementation
// ============================================================================

export class KyselyReportsStorage implements ReportsStorage {
  constructor(private db: Kysely<Database>) {}

  async list(
    organizationId: string,
    filters?: { category?: string; status?: ReportStatus },
  ): Promise<Report[]> {
    let query = this.db
      .selectFrom("reports")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("updated_at", "desc");

    if (filters?.category) {
      query = query.where("category", "=", filters.category);
    }
    if (filters?.status) {
      query = query.where("status", "=", filters.status);
    }

    const rows = await query.execute();
    return rows.map((row) => this.fromDbRow(row));
  }

  async get(id: string, organizationId: string): Promise<Report | null> {
    const row = await this.db
      .selectFrom("reports")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!row) return null;
    return this.fromDbRow(row);
  }

  async upsert(
    organizationId: string,
    data: Omit<Report, "updatedAt"> & { id?: string },
  ): Promise<Report> {
    const now = new Date().toISOString();
    const id = data.id ?? generatePrefixedId("rpt");

    const existing = await this.get(id, organizationId);

    if (existing) {
      await this.db
        .updateTable("reports")
        .set({
          title: data.title,
          category: data.category,
          status: data.status,
          summary: data.summary,
          source: data.source ?? null,
          tags: data.tags ? JSON.stringify(data.tags) : null,
          lifecycle_status: data.lifecycleStatus ?? null,
          sections: JSON.stringify(data.sections),
          updated_at: now,
        })
        .where("id", "=", id)
        .where("organization_id", "=", organizationId)
        .execute();

      const updated = await this.get(id, organizationId);
      if (!updated) throw new Error(`Report ${id} not found after update`);
      return updated;
    }

    await this.db
      .insertInto("reports")
      .values({
        id,
        organization_id: organizationId,
        title: data.title,
        category: data.category,
        status: data.status,
        summary: data.summary,
        source: data.source ?? null,
        tags: data.tags ? JSON.stringify(data.tags) : null,
        lifecycle_status: data.lifecycleStatus ?? "unread",
        sections: JSON.stringify(data.sections),
        created_at: now,
        updated_at: now,
      })
      .execute();

    const inserted = await this.get(id, organizationId);
    if (!inserted) throw new Error(`Report ${id} not found after insert`);
    return inserted;
  }

  async updateLifecycleStatus(
    id: string,
    organizationId: string,
    status: ReportLifecycleStatus,
  ): Promise<{ success: boolean }> {
    const result = await this.db
      .updateTable("reports")
      .set({
        lifecycle_status: status,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return { success: (result.numUpdatedRows ?? 0n) > 0n };
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private fromDbRow(row: {
    id: string;
    organization_id: string;
    title: string;
    category: string;
    status: string;
    summary: string;
    source: string | null;
    tags: string | string[] | null;
    lifecycle_status: string | null;
    sections: string | ReportSection[];
    created_at: string | Date;
    updated_at: string | Date;
  }): Report {
    const tags = row.tags
      ? typeof row.tags === "string"
        ? (JSON.parse(row.tags) as string[])
        : row.tags
      : undefined;

    const sections =
      typeof row.sections === "string"
        ? (JSON.parse(row.sections) as ReportSection[])
        : row.sections;

    const updatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at;

    return {
      id: row.id,
      title: row.title,
      category: row.category,
      status: row.status as ReportStatus,
      summary: row.summary,
      updatedAt,
      source: row.source ?? undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
      lifecycleStatus:
        (row.lifecycle_status as ReportLifecycleStatus) ?? undefined,
      sections,
    };
  }
}
