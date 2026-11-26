/** Real-Postgres coverage for what a store knows (the engine's knowledge base). */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { PlanEngineKnowledgeStorage } from "./plan-engine-knowledge";
import type { Database } from "./types";

const ORG = "org_plan_knowledge";

const draft = {
  conhecimento: "bloco de recomendação empatou",
  categoria: "ux" as const,
  fonte: "Teste A/B 54",
  fonte_url: null,
  tipo_fonte: "ab_desta_loja" as const,
  contexto: "PDP, site",
  areas: ["galeria" as const],
  evidencia: "+5,8% não significativo",
  confiabilidade: "alta" as const,
  limitacoes: "",
  resultado: "neutro" as const,
  origem: "manual" as const,
  diagnosis_id: null,
  hypothesis_id: null,
  active: true,
};

describe("PlanEngineKnowledgeStorage", () => {
  let database: StudioDatabase;
  let knowledge: PlanEngineKnowledgeStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "plan-knowledge",
        createdAt: new Date().toISOString(),
      })
      .execute();
    knowledge = new PlanEngineKnowledgeStorage(database.db);
  });

  beforeEach(async () => {
    await sql`TRUNCATE plan_ux_knowledge`.execute(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("writes, reads back and replaces by id, keeping the creation date", async () => {
    const first = await knowledge.upsertKnowledge(ORG, {
      ...draft,
      id: "veredito:h1",
    });
    expect(first.areas).toEqual(["galeria"]);
    expect(first.active).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const again = await knowledge.upsertKnowledge(ORG, {
      ...draft,
      id: "veredito:h1",
      conhecimento: "outra",
    });
    expect(again.conhecimento).toBe("outra");
    expect(again.created_at).toBe(first.created_at);
    expect(again.updated_at > first.updated_at).toBe(true);
    expect(await knowledge.listKnowledge(ORG)).toHaveLength(1);
  });

  it("without an id it gets one; turned off, it leaves the run's read", async () => {
    const e = await knowledge.upsertKnowledge(ORG, draft);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    await knowledge.setKnowledgeActive(ORG, e.id, false);
    expect(
      await knowledge.listKnowledge(ORG, { activeOnly: true }),
    ).toHaveLength(0);
    expect(await knowledge.listKnowledge(ORG)).toHaveLength(1);
    const run = await knowledge.knowledgeForRun(ORG, []);
    expect(run).toEqual({ entries: [], error: null });
  });

  it("refuses a category or source type outside the list", async () => {
    await expect(
      knowledge.upsertKnowledge(ORG, {
        ...draft,
        tipo_fonte: "palpite" as never,
      }),
    ).rejects.toThrow();
    await expect(
      knowledge.upsertKnowledge(ORG, { ...draft, categoria: "x" as never }),
    ).rejects.toThrow();
  });

  it("a failed read gives the run only the curated entries, with why", async () => {
    const pool = new Pool({
      connectionString: "postgresql://nobody@127.0.0.1:1/none",
    });
    const unreachable = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
    });
    try {
      const out = await new PlanEngineKnowledgeStorage(
        unreachable,
      ).knowledgeForRun(ORG, []);
      expect(out.entries).toEqual([]);
      expect(out.error).toBeTruthy();
    } finally {
      await unreachable.destroy();
    }
  });
});
