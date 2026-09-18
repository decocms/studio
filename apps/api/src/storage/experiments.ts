/**
 * Experiment Storage — per-site A/B experiment metadata (name, key, status,
 * goals, variants). The actual traffic-split block lives in the site's decofile,
 * not here; this table is the management/tracking record the Studio tab reads.
 */

import type { Kysely, Updateable } from "kysely";
import type {
  Database,
  Experiment,
  ExperimentTable,
  ExperimentVariant,
} from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

export interface CreateExperimentInput {
  organizationId: string;
  site: string;
  key: string;
  name: string;
  goals?: string[];
  variants?: ExperimentVariant[];
  createdBy: string;
}

export interface UpdateExperimentInput {
  name?: string;
  status?: Experiment["status"];
  goals?: string[];
  variants?: ExperimentVariant[];
}

export class ExperimentStorage {
  constructor(private db: Kysely<Database>) {}

  /** All experiments for one site, newest first. */
  async listBySite(
    organizationId: string,
    site: string,
  ): Promise<Experiment[]> {
    const rows = await this.db
      .selectFrom("experiments")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("site", "=", site)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => this.fromRow(row));
  }

  async getByKey(
    organizationId: string,
    site: string,
    key: string,
  ): Promise<Experiment | null> {
    const row = await this.db
      .selectFrom("experiments")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("site", "=", site)
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? this.fromRow(row) : null;
  }

  async create(input: CreateExperimentInput): Promise<Experiment> {
    const id = generatePrefixedId("exp");
    const now = new Date().toISOString();
    await this.db
      .insertInto("experiments")
      .values({
        id,
        organization_id: input.organizationId,
        site: input.site,
        key: input.key,
        name: input.name,
        status: "draft",
        goals: JSON.stringify(input.goals ?? []),
        variants: JSON.stringify(input.variants ?? []),
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const created = await this.getByKey(
      input.organizationId,
      input.site,
      input.key,
    );
    if (!created) throw new Error("failed to create experiment");
    return created;
  }

  /** Patch a definition. Stamps `started_at` the first time it goes running and
   *  `ended_at` when it ends. Returns null when no row matches. */
  async update(
    organizationId: string,
    site: string,
    key: string,
    patch: UpdateExperimentInput,
  ): Promise<Experiment | null> {
    const current = await this.getByKey(organizationId, site, key);
    if (!current) return null;

    const now = new Date().toISOString();
    const set: Updateable<ExperimentTable> = { updated_at: now };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.goals !== undefined) set.goals = JSON.stringify(patch.goals);
    if (patch.variants !== undefined) {
      set.variants = JSON.stringify(patch.variants);
    }
    if (patch.status !== undefined) {
      set.status = patch.status;
      if (patch.status === "running" && !current.startedAt)
        set.started_at = now;
      if (patch.status === "ended" && !current.endedAt) set.ended_at = now;
    }

    await this.db
      .updateTable("experiments")
      .set(set)
      .where("organization_id", "=", organizationId)
      .where("site", "=", site)
      .where("key", "=", key)
      .execute();
    return this.getByKey(organizationId, site, key);
  }

  async delete(
    organizationId: string,
    site: string,
    key: string,
  ): Promise<boolean> {
    const res = await this.db
      .deleteFrom("experiments")
      .where("organization_id", "=", organizationId)
      .where("site", "=", site)
      .where("key", "=", key)
      .executeTakeFirst();
    return (res.numDeletedRows ?? 0n) > 0n;
  }

  private fromRow(row: {
    id: string;
    organization_id: string;
    site: string;
    key: string;
    name: string;
    status: string;
    goals: unknown;
    variants: unknown;
    started_at: Date | string | null;
    ended_at: Date | string | null;
    created_by: string;
    created_at: Date | string;
    updated_at: Date | string;
  }): Experiment {
    const iso = (v: Date | string) => new Date(v).toISOString();
    return {
      id: row.id,
      organizationId: row.organization_id,
      site: row.site,
      key: row.key,
      name: row.name,
      status: (["running", "paused", "ended"].includes(row.status)
        ? row.status
        : "draft") as Experiment["status"],
      goals: (row.goals ?? []) as string[],
      variants: (row.variants ?? []) as ExperimentVariant[],
      startedAt: row.started_at ? iso(row.started_at) : null,
      endedAt: row.ended_at ? iso(row.ended_at) : null,
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}
