import type { Database } from "@/storage/types";
import type { Kysely } from "kysely";
import type { ResearchedFact } from "./research";

export type FactStatus = "proposed" | "confirmed" | "rejected";

export interface TelosFact {
  id: string;
  label: string;
  value: string;
  confidence: string;
  status: FactStatus;
  sourceUrl: string | null;
}

// DB access for the tentative onboarding facts. Append on research; the user
// then confirms/rejects each from the home.
export class FactStore {
  constructor(private readonly db: Kysely<Database>) {}

  async insertMany(
    organizationId: string,
    facts: ResearchedFact[],
  ): Promise<void> {
    if (facts.length === 0) return;
    await this.db
      .insertInto("telos_fact")
      .values(
        facts.map((f) => ({
          id: `fact_${crypto.randomUUID()}`,
          organization_id: organizationId,
          label: f.label,
          value: f.value,
          confidence: f.confidence,
          status: "proposed",
          source_url: f.sourceUrl ?? null,
        })),
      )
      .execute();
  }

  async list(organizationId: string): Promise<TelosFact[]> {
    const rows = await this.db
      .selectFrom("telos_fact")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("status", "!=", "rejected")
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      value: r.value,
      confidence: r.confidence,
      status: r.status as FactStatus,
      sourceUrl: r.source_url,
    }));
  }

  async setStatus(
    organizationId: string,
    factId: string,
    status: FactStatus,
  ): Promise<void> {
    await this.db
      .updateTable("telos_fact")
      .set({ status, updated_at: new Date().toISOString() })
      .where("organization_id", "=", organizationId)
      .where("id", "=", factId)
      .execute();
  }

  async count(organizationId: string): Promise<number> {
    const row = await this.db
      .selectFrom("telos_fact")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }
}
