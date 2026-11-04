import type { Kysely, Selectable } from "kysely";
import type { DraftStoragePort } from "./ports";
import type { CmsDraftRow, CmsDraftTable, Database } from "./types";

function toRow(row: Selectable<CmsDraftTable>): CmsDraftRow {
  return {
    site: row.site,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    via: row.via,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** The hosted CMS's named drafts (migration 261). */
export class DraftStorage implements DraftStoragePort {
  constructor(private readonly db: Kysely<Database>) {}

  async list(site: string): Promise<CmsDraftRow[]> {
    const rows = await this.db
      .selectFrom("drafts")
      .selectAll()
      .where("site", "=", site)
      .orderBy("created_at", "desc")
      .orderBy("name")
      .execute();
    return rows.map(toRow);
  }

  async get(site: string, name: string): Promise<CmsDraftRow | null> {
    const row = await this.db
      .selectFrom("drafts")
      .selectAll()
      .where("site", "=", site)
      .where("name", "=", name)
      .executeTakeFirst();
    return row ? toRow(row) : null;
  }

  async insertIfAbsent(
    row: Omit<CmsDraftRow, "createdAt">,
  ): Promise<{ row: CmsDraftRow; created: boolean }> {
    const inserted = await this.db
      .insertInto("drafts")
      .values({
        site: row.site,
        name: row.name,
        slug: row.slug,
        created_by: row.createdBy,
        via: row.via,
      })
      .onConflict((oc) => oc.columns(["site", "name"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { row: toRow(inserted), created: true };
    const existing = await this.get(row.site, row.name);
    if (!existing) {
      throw new Error(`draft ${row.site}/${row.name} vanished while created`);
    }
    return { row: existing, created: false };
  }

  async delete(site: string, name: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("drafts")
      .where("site", "=", site)
      .where("name", "=", name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
