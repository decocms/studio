/**
 * Real-Postgres coverage for the store-analysis engine's storage: the
 * per-org isolation, the "running" lock, re-verification claims, the
 * reaper, retiring an opportunity, and the confirmed competitor list.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { PlanEngineCostStorage } from "./plan-engine-costs";
import { PlanEngineKnowledgeStorage } from "./plan-engine-knowledge";
import { PlanEngineStorage, retiredId } from "./plan-engine";

const ORG_A = "org_plan_engine_a";
const ORG_B = "org_plan_engine_b";

const opportunity = {
  rank: 1,
  area: "tamanho" as const,
  title: "Tamanho",
  summary: "",
  device: "mobile" as const,
  sources: [],
  money: null,
  confidence: 0.5,
};

const hypothesis = {
  kind: "proposta" as const,
  rank: 1,
  opportunity_id: null,
  title: "h",
  device: "mobile" as const,
  evidence_md: "",
  idea: "i",
  why: "w",
  where: "",
  money: null,
  confidence: 0.5,
  benchmark_refs: [],
  benchmark: [],
  before_url: null,
};

const knowledge = {
  conhecimento: "bloco de recomendação empatou",
  categoria: "ux" as const,
  fonte: "Teste A/B",
  fonte_url: null,
  tipo_fonte: "ab_desta_loja" as const,
  contexto: "PDP",
  areas: [],
  evidencia: "",
  confiabilidade: "alta" as const,
  limitacoes: "",
  resultado: "neutro" as const,
  origem: "manual" as const,
  diagnosis_id: null,
  hypothesis_id: null,
  active: true,
};

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

describe("PlanEngineStorage", () => {
  let database: StudioDatabase;
  let store: PlanEngineStorage;
  let knowledgeStore: PlanEngineKnowledgeStorage;
  let costs: PlanEngineCostStorage;

  async function addDiagnosis(
    id: string,
    status: string,
    startedMinutesAgo: number,
    restartedMinutesAgo: number | null = null,
    pageType = "pdp",
    org = ORG_A,
  ) {
    await sql`
      INSERT INTO plan_ux_diagnoses
        (id, organization_id, status, domain, started_at, restarted_at, page_type)
      VALUES (${id}, ${org}, ${status}, 'x', ${minutesAgo(startedMinutesAgo)},
              ${restartedMinutesAgo === null ? null : minutesAgo(restartedMinutesAgo)},
              ${pageType})
    `.execute(database.db);
  }

  async function diagnosisRow(id: string) {
    const { rows } = await sql<Record<string, unknown>>`
      SELECT * FROM plan_ux_diagnoses WHERE id = ${id}
    `.execute(database.db);
    return rows[0] ?? {};
  }

  /** A diagnosis of org A with one opportunity and one hypothesis. */
  async function seedOrgA() {
    const d = await store.insertDiagnosis(ORG_A, { domain: "a.example" });
    const o = await store.putOpportunityAt(ORG_A, d.id, opportunity);
    await store.replaceOpportunityHypotheses(ORG_A, d.id, o.id, [hypothesis]);
    const [h] = await store.listHypotheses(ORG_A, d.id);
    if (!h) throw new Error("expected a hypothesis");
    return { d, o, h };
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const [id, slug] of [
      [ORG_A, "plan-engine-a"],
      [ORG_B, "plan-engine-b"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt: now })
        .execute();
    }
    store = new PlanEngineStorage(database.db);
    knowledgeStore = new PlanEngineKnowledgeStorage(database.db);
    costs = new PlanEngineCostStorage(database.db);
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE plan_ux_site_profiles, plan_ux_diagnoses, plan_ux_opportunities,
               plan_ux_hypotheses, plan_ux_benchmark_pdps, plan_ux_knowledge,
               plan_cost_events
    `.execute(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  describe("schema", () => {
    it("every table belongs to an organization and has no default for it", async () => {
      const { rows } = await sql<{
        table_name: string;
        is_nullable: string;
        column_default: string | null;
      }>`
        SELECT table_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE column_name = 'organization_id'
           AND (table_name LIKE 'plan_ux_%' OR table_name = 'plan_cost_events')
         ORDER BY table_name
      `.execute(database.db);
      expect(rows.map((r) => r.table_name)).toEqual([
        "plan_cost_events",
        "plan_ux_benchmark_pdps",
        "plan_ux_diagnoses",
        "plan_ux_hypotheses",
        "plan_ux_knowledge",
        "plan_ux_opportunities",
        "plan_ux_site_profiles",
      ]);
      for (const r of rows) {
        expect(r.is_nullable).toBe("NO");
        expect(r.column_default).toBeNull();
      }
    });

    it("a write without the organization fails", async () => {
      await expect(
        sql`
          INSERT INTO plan_ux_diagnoses (id, domain, started_at)
          VALUES ('d', 'x', now())
        `.execute(database.db),
      ).rejects.toThrow(/organization_id/);
    });

    it("deleting the organization deletes its rows", async () => {
      const orgId = "org_plan_engine_gone";
      await database.db
        .insertInto("organization")
        .values({
          id: orgId,
          name: orgId,
          slug: "plan-engine-gone",
          createdAt: new Date().toISOString(),
        })
        .execute();
      await store.upsertSiteProfile(orgId, { domain: "gone.example" });
      const d = await store.insertDiagnosis(orgId, { domain: "gone.example" });
      const o = await store.putOpportunityAt(orgId, d.id, opportunity);
      await store.replaceOpportunityHypotheses(orgId, d.id, o.id, [hypothesis]);
      await knowledgeStore.upsertKnowledge(orgId, knowledge);

      await database.db
        .deleteFrom("organization")
        .where("id", "=", orgId)
        .execute();

      const { rows } = await sql<{ n: string }>`
        SELECT (SELECT COUNT(*) FROM plan_ux_site_profiles WHERE organization_id = ${orgId})
             + (SELECT COUNT(*) FROM plan_ux_diagnoses WHERE organization_id = ${orgId})
             + (SELECT COUNT(*) FROM plan_ux_opportunities WHERE organization_id = ${orgId})
             + (SELECT COUNT(*) FROM plan_ux_hypotheses WHERE organization_id = ${orgId})
             + (SELECT COUNT(*) FROM plan_ux_knowledge WHERE organization_id = ${orgId}) AS n
      `.execute(database.db);
      expect(Number(rows[0]?.n)).toBe(0);
    });
  });

  describe("site profile", () => {
    it("a new profile has no confirmation; confirming stamps the date", async () => {
      const p = await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
      });
      expect(p.competitors_confirmed_at).toBeNull();
      const confirmed = await store.upsertSiteProfile(ORG_A, {
        competitors: ["a.example"],
        competitors_confirmed: true,
      });
      expect(confirmed.competitors).toEqual(["a.example"]);
      expect(confirmed.competitors_confirmed_at).not.toBeNull();
    });

    it("a profile needs a domain to be created", async () => {
      await expect(
        store.upsertSiteProfile(ORG_A, { studio_site: "x" }),
      ).rejects.toThrow(/domain is required/);
    });

    it("confirming on create stamps the date", async () => {
      const p = await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
        competitors: ["a.example"],
        competitors_confirmed: true,
      });
      expect(p.competitors_confirmed_at).not.toBeNull();
    });

    it("a patch without the flag keeps the confirmation; false clears it", async () => {
      await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
        competitors: ["a.example"],
        competitors_confirmed: true,
      });
      const kept = await store.upsertSiteProfile(ORG_A, { studio_site: "x" });
      expect(kept.competitors_confirmed_at).not.toBeNull();
      const cleared = await store.upsertSiteProfile(ORG_A, {
        competitors_confirmed: false,
      });
      expect(cleared.competitors).toEqual(["a.example"]);
      expect(cleared.competitors_confirmed_at).toBeNull();
    });

    it("another store clears the list; the same store or only its www. keeps it", async () => {
      const before = await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
        competitors: ["a.example"],
        competitors_confirmed: true,
      });
      const same = await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
      });
      expect(same.competitors_confirmed_at).toBe(
        before.competitors_confirmed_at,
      );
      const www = await store.upsertSiteProfile(ORG_A, {
        domain: "www.loja.example",
      });
      expect(www.domain).toBe("www.loja.example");
      expect(www.competitors).toEqual(["a.example"]);
      expect(www.competitors_confirmed_at).toBe(
        before.competitors_confirmed_at,
      );
      const other = await store.upsertSiteProfile(ORG_A, {
        domain: "outra.example",
      });
      expect(other.competitors).toEqual([]);
      expect(other.competitors_confirmed_at).toBeNull();
    });

    it("a run's write-back replaces a suggested list, never a confirmed one", async () => {
      await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
        competitors: ["a.example"],
      });
      await store.replaceSuggestedCompetitors(ORG_A, ["sugerida.example"]);
      expect((await store.getSiteProfile(ORG_A))?.competitors).toEqual([
        "sugerida.example",
      ]);
      await store.upsertSiteProfile(ORG_A, {
        competitors: ["b.example"],
        competitors_confirmed: true,
      });
      await store.replaceSuggestedCompetitors(ORG_A, ["outra.example"]);
      expect((await store.getSiteProfile(ORG_A))?.competitors).toEqual([
        "b.example",
      ]);
    });

    it("creating a profile keeps the repository, the project and the page routes it was given", async () => {
      const templates = { home: "/", busca: "/s", categoria: null };
      const created = await store.upsertSiteProfile(ORG_A, {
        domain: "loja.example",
        code_repo: "acme/loja",
        code_project_id: "vir_loja",
        page_templates: templates as never,
      });
      expect(created).toMatchObject({
        code_repo: "acme/loja",
        code_project_id: "vir_loja",
        page_templates: templates,
      });
      const plain = await store.upsertSiteProfile(ORG_B, {
        domain: "outra.example",
      });
      expect(plain).toMatchObject({
        code_repo: null,
        code_project_id: null,
        page_templates: null,
      });
    });

    it("no longer writes code_volume", async () => {
      await store.upsertSiteProfile(ORG_A, { domain: "loja.example" });
      await sql`
        UPDATE plan_ux_site_profiles SET code_volume = 'old-volume'
         WHERE organization_id = ${ORG_A}
      `.execute(database.db);
      const profile = await store.upsertSiteProfile(ORG_A, {
        code_repo: "acme/loja",
      });
      expect(profile).not.toHaveProperty("code_volume");
      const { rows } = await sql<{ code_volume: string | null }>`
        SELECT code_volume FROM plan_ux_site_profiles
         WHERE organization_id = ${ORG_A}
      `.execute(database.db);
      expect(rows[0]?.code_volume).toBe("old-volume");
    });

    it("JSON columns round-trip, and the profile is per org", async () => {
      await store.upsertSiteProfile(ORG_A, { domain: "a.example" });
      const sources = {
        detected_at: "2026-11-20T00:00:00.000Z",
        studio_project: null,
        repository: null,
        analytics_site: null,
        errors: ["sem projeto"],
      };
      await store.saveSiteSources(
        ORG_A,
        sources as unknown as Parameters<typeof store.saveSiteSources>[1],
      );
      await store.upsertSiteProfile(ORG_A, {
        page_templates: { home: "/", busca: null } as never,
      });
      const a = await store.getSiteProfile(ORG_A);
      expect(a?.sources).toEqual(sources as never);
      expect(a?.page_templates).toEqual({ home: "/", busca: null } as never);
      expect(await store.getSiteProfile(ORG_B)).toBeNull();
      await store.upsertSiteProfile(ORG_B, { domain: "b.example" });
      expect((await store.getSiteProfile(ORG_A))?.domain).toBe("a.example");
    });

    it("the theme read from the repository round-trips and replaces the last one, per org", async () => {
      await store.upsertSiteProfile(ORG_A, { domain: "a.example" });
      await store.upsertSiteProfile(ORG_B, { domain: "b.example" });
      const tokens = (read_at: string) => ({
        repo: "acme/loja-exemplo",
        commit: read_at,
        read_at,
        files: ["tailwind.config.ts", ".deco/blocks/site.json"],
        css_variables: { "--rounded-btn": "2rem" },
        theme: { "colors.primary": "#333333" },
        colors: [{ name: "primary", value: "#333333", usage: "botão" }],
        fonts: [],
        radii: [{ name: "--rounded-btn", value: "2rem" }],
        conventions: null,
      });
      await store.saveCodeTokens(ORG_A, tokens("2026-11-20T00:00:00.000Z"));
      await store.saveCodeTokens(ORG_A, {
        ...tokens("2026-11-25T00:00:00.000Z"),
        model_error: "timeout",
      });
      expect((await store.getSiteProfile(ORG_A))?.code_tokens).toEqual({
        ...tokens("2026-11-25T00:00:00.000Z"),
        model_error: "timeout",
      });
      expect((await store.getSiteProfile(ORG_B))?.code_tokens).toBeNull();
    });
  });

  describe("tenancy", () => {
    it("a diagnosis of org A is not visible to org B", async () => {
      const d = await store.insertDiagnosis(ORG_A, { domain: "a.example" });
      expect(await store.getDiagnosis(ORG_B, d.id)).toBeNull();
      expect(await store.listDiagnoses(ORG_B, 10)).toEqual([]);
      expect((await store.getDiagnosis(ORG_A, d.id))?.id).toBe(d.id);
      expect(await store.listDiagnoses(ORG_A, 10)).toHaveLength(1);
    });

    it("hypotheses and opportunities are scoped", async () => {
      const { d, h, o } = await seedOrgA();
      expect(await store.getHypothesis(ORG_B, h.id)).toBeNull();
      expect(await store.getOpportunity(ORG_B, o.id)).toBeNull();
      expect(await store.listOpportunities(ORG_B, d.id)).toEqual([]);
      expect(await store.listHypotheses(ORG_B, d.id)).toEqual([]);
      expect((await store.getHypothesis(ORG_A, h.id))?.id).toBe(h.id);
      expect((await store.getOpportunity(ORG_A, o.id))?.page_type).toBe("pdp");
    });

    it("org B cannot write to org A's rows by id", async () => {
      const { d, h } = await seedOrgA();
      await store.updateDiagnosis(ORG_B, d.id, { status: "error", error: "x" });
      expect((await store.getDiagnosis(ORG_A, d.id))?.status).toBe("running");
      expect(
        await store.setHypothesisStatus(ORG_B, h.id, "approved", null),
      ).toBeNull();
      expect((await store.getHypothesis(ORG_A, h.id))?.status).toBe("pending");
      await store.updateDiagnosis(ORG_A, d.id, {
        status: "done",
        finished: true,
      });
      expect(await store.claimDiagnosisForVerify(ORG_B, d.id)).toBe(false);
    });

    it("the running lock is per org", async () => {
      await store.insertDiagnosis(ORG_A, { domain: "a.example" });
      expect(await store.fetchRunningDiagnosis(ORG_B, "pdp")).toBeNull();
      expect(await store.fetchRunningDiagnosis(ORG_A, "pdp")).not.toBeNull();
      const b = await store.insertDiagnosis(ORG_B, { domain: "b.example" });
      await store.updateDiagnosis(ORG_B, b.id, {
        status: "done",
        finished: true,
      });
      expect(await store.claimDiagnosisForVerify(ORG_B, b.id)).toBe(true);
    });

    it("retiring onto an id another org holds fails closed", async () => {
      const b = await store.insertDiagnosis(ORG_B, { domain: "b.example" });
      const fallen = await store.putOpportunityAt(ORG_B, b.id, opportunity);
      await store.replaceOpportunityHypotheses(ORG_B, b.id, fallen.id, [
        hypothesis,
      ]);
      const [h] = await store.listHypotheses(ORG_B, b.id);
      const a = await store.insertDiagnosis(ORG_A, {
        domain: "a.example",
        page_type: "home",
      });
      await sql`
        INSERT INTO plan_ux_opportunities
          (organization_id, id, diagnosis_id, rank, title, updated_at)
        VALUES (${ORG_A}, ${retiredId(fallen.id)}, ${a.id}, 101, 'de A', now())
      `.execute(database.db);

      await expect(
        store.retireOpportunity(ORG_B, fallen, {
          stop: "todas_descartadas",
          retired: true,
          note: "x",
        }),
      ).rejects.toThrow();
      expect(
        (await store.listOpportunities(ORG_B, b.id)).map((o) => o.id),
      ).toEqual([fallen.id]);
      expect(
        (await store.getHypothesis(ORG_B, h?.id ?? ""))?.opportunity_id,
      ).toBe(fallen.id);
      expect(
        (await store.listOpportunities(ORG_A, a.id)).map((o) => o.title),
      ).toEqual(["de A"]);
    });

    it("putting an opportunity on an id another org holds does not overwrite it", async () => {
      const a = await store.insertDiagnosis(ORG_A, { domain: "a.example" });
      await sql`
        INSERT INTO plan_ux_opportunities
          (organization_id, id, diagnosis_id, rank, title, updated_at)
        VALUES (${ORG_A}, ${`${a.id}:o1`}, ${a.id}, 1, 'de A', now())
      `.execute(database.db);
      await expect(
        store.putOpportunityAt(ORG_B, a.id, opportunity),
      ).rejects.toThrow(/não gravou/);
      expect(
        (await store.listOpportunities(ORG_A, a.id)).map((o) => o.title),
      ).toEqual(["de A"]);
    });

    it("knowledge is per org, and an id another org holds is not overwritten", async () => {
      const a = await knowledgeStore.upsertKnowledge(ORG_A, knowledge);
      expect(await knowledgeStore.listKnowledge(ORG_B)).toEqual([]);
      expect(await knowledgeStore.getKnowledge(ORG_B, a.id)).toBeNull();
      expect(
        await knowledgeStore.setKnowledgeActive(ORG_B, a.id, false),
      ).toBeNull();
      await expect(
        knowledgeStore.upsertKnowledge(ORG_B, {
          ...knowledge,
          id: a.id,
          fonte: "outra",
        }),
      ).rejects.toThrow();
      const [kept] = await knowledgeStore.listKnowledge(ORG_A);
      expect(kept?.fonte).toBe("Teste A/B");
      expect(kept?.active).toBe(true);
    });

    it("cost events are written once and summed per org", async () => {
      const draft = {
        key: "c0",
        provider: "openrouter",
        kind: "chat",
        feature: "ux_diagnosis",
        model: "m",
        unitsIn: 1,
        unitsOut: 1,
        costUsd: 0.5,
      };
      expect(await costs.insertCostEvents(ORG_A, "ux:a", [draft])).toBe(1);
      expect(await costs.insertCostEvents(ORG_A, "ux:a", [draft])).toBe(0);
      await costs.insertCostEvents(ORG_B, "ux:b", [{ ...draft, costUsd: 2 }]);
      const filters = {
        from: "2000-01-01",
        to: "2100-01-01",
        granularity: "day" as const,
      };
      const a = await costs.summarizeCosts(ORG_A, filters);
      expect(a.total_usd).toBe(0.5);
      expect(a.events).toBe(1);
      expect(a.series).toHaveLength(1);
      expect((await costs.summarizeCosts("org_none", filters)).events).toBe(0);
    });
  });

  describe("cost summary", () => {
    it("buckets in UTC, counts unpriced events apart, and ends the window exclusively", async () => {
      const base = {
        provider: "openrouter",
        kind: "chat",
        feature: "ux_diagnosis",
        model: "m",
        unitsIn: 3_000_000_000,
        unitsOut: 1,
      };
      await costs.insertCostEvents(ORG_A, "s", [
        { ...base, key: "1", at: "2026-01-05T23:30:00.000Z", costUsd: 1 },
        { ...base, key: "2", at: "2026-01-04T10:00:00.000Z", costUsd: null },
        { ...base, key: "3", at: "2026-01-12T00:00:00.000Z", costUsd: 5 },
      ]);
      const week = await costs.summarizeCosts(ORG_A, {
        from: "2026-01-01",
        to: "2026-01-12",
        granularity: "week",
      });
      expect(week.events).toBe(2);
      expect(week.unpriced_events).toBe(1);
      expect(week.unpriced_models).toEqual(["m"]);
      expect(week.series.map((b) => b.bucket)).toEqual([
        "2026-W00",
        "2026-W01",
      ]);
      expect(week.by_model[0]?.units_in).toBe(6_000_000_000);
      const month = await costs.summarizeCosts(ORG_A, {
        from: "2026-01-01",
        to: "2026-02-01",
        granularity: "month",
      });
      expect(month.series).toEqual([
        { bucket: "2026-01", usd: 6, by_feature: { ux_diagnosis: 6 } },
      ]);
    });
  });

  describe("diagnoses", () => {
    it("starting a page while it runs returns null; another page starts", async () => {
      const first = await store.insertDiagnosisIfIdle(ORG_A, {
        domain: "a.example",
        page_type: "pdp",
        site_run_id: "run1",
        goal_id: "goal1",
        objective_statement: "vender mais",
      });
      expect(first?.goal_id).toBe("goal1");
      expect(
        await store.insertDiagnosisIfIdle(ORG_A, {
          domain: "a.example",
          page_type: "pdp",
        }),
      ).toBeNull();
      expect(
        await store.insertDiagnosisIfIdle(ORG_A, {
          domain: "a.example",
          page_type: "home",
        }),
      ).not.toBeNull();
    });

    it("concurrent starts of the same page: exactly one wins", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.insertDiagnosisIfIdle(ORG_A, {
            domain: "a.example",
            page_type: "busca",
          }),
        ),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("counts starts since a time, per org", async () => {
      await addDiagnosis("old", "done", 48 * 60);
      await addDiagnosis("new", "done", 10, null, "home");
      expect(
        await store.countDiagnosesStartedSince(ORG_A, minutesAgo(24 * 60)),
      ).toBe(1);
      expect(
        await store.countDiagnosesStartedSince(ORG_B, minutesAgo(24 * 60)),
      ).toBe(0);
    });

    it("site runs group a run's pages, newest first, and filter by goal", async () => {
      const at = "2026-11-20T10:00:00.000Z";
      for (const [id, run, page, status, goal] of [
        ["d1", "r1", "pdp", "done", "g1"],
        ["d2", "r1", "home", "error", "g1"],
        ["d3", null, "busca", "error", null],
        ["d4", "r2", "categoria", "running", "g2"],
      ] as const) {
        await sql`
          INSERT INTO plan_ux_diagnoses
            (id, organization_id, status, domain, started_at, page_type,
             site_run_id, goal_id)
          VALUES (${id}, ${ORG_A}, ${status}, 'x', ${at}, ${page}, ${run}, ${goal})
        `.execute(database.db);
      }
      const runs = await store.listSiteRuns(ORG_A);
      // Same start: the one inserted last is the newest.
      expect(runs.map((r) => [r.site_run_id, r.status, r.pages])).toEqual([
        ["r2", "running", ["categoria"]],
        ["d3", "error", ["busca"]],
        ["r1", "done", ["home", "pdp"]],
      ]);
      expect(runs[2]?.started_at).toBe(at);
      expect(
        (await store.listSiteRuns(ORG_A, { goalId: "g1" })).map(
          (r) => r.site_run_id,
        ),
      ).toEqual(["r1"]);
      expect(
        (await store.listDiagnosesForGoal(ORG_A, null)).map((d) => d.id),
      ).toEqual(["d4", "d3", "d2", "d1"]);
      expect(
        (await store.listDiagnoses(ORG_A, 20, "r1")).map((d) => d.id).sort(),
      ).toEqual(["d1", "d2"]);
    });

    it("the list counts what is on screen: a retired opportunity and its hypotheses stay out", async () => {
      const { d, o } = await seedOrgA();
      const second = await store.putOpportunityAt(ORG_A, d.id, {
        ...opportunity,
        rank: 2,
        title: "Segunda",
      });
      await store.replaceOpportunityHypotheses(ORG_A, d.id, second.id, [
        hypothesis,
        { ...hypothesis, rank: 2 },
      ]);
      const [h] = await store.listHypotheses(ORG_A, d.id);
      await store.setHypothesisStatus(ORG_A, h?.id ?? "", "approved", null);
      await store.retireOpportunity(ORG_A, o, {
        stop: "todas_descartadas",
        retired: true,
        note: "x",
      });
      const [item] = await store.listDiagnoses(ORG_A);
      expect(item?.opportunities_total).toBe(1);
      expect(item?.hypotheses_total).toBe(2);
      expect(item?.hypotheses_approved).toBe(0);
      expect(item && "evidence" in item).toBe(false);
    });

    it("summary and evidence round-trip as JSON", async () => {
      const d = await store.insertDiagnosis(ORG_A, { domain: "a.example" });
      const evidence = { window_days: 7, gaps: [], captures: [] };
      await store.updateDiagnosis(ORG_A, d.id, {
        evidence: evidence as never,
        cost_usd: 1.25,
        stage: "done" as never,
      });
      const back = await store.getDiagnosis(ORG_A, d.id);
      expect(back?.evidence).toEqual(evidence as never);
      expect(back?.cost_usd).toBe(1.25);
    });
  });

  describe("re-verification and the reaper", () => {
    it("reaper: a restart today of yesterday's diagnosis stays", async () => {
      await addDiagnosis("old-rerun", "running", 24 * 60, 5);
      await store.reapStaleDiagnoses(ORG_A);
      expect((await diagnosisRow("old-rerun")).status).toBe("running");
    });

    it("reaper: a restart past the deadline falls", async () => {
      await addDiagnosis("dead-rerun", "running", 24 * 60, 120);
      await store.reapStaleDiagnoses(ORG_A);
      expect((await diagnosisRow("dead-rerun")).status).toBe("error");
    });

    it("reaper: without a restart, started_at counts", async () => {
      await addDiagnosis("fresh", "running", 10);
      await addDiagnosis("stale", "running", 120, null, "home");
      await store.reapStaleDiagnoses(ORG_A);
      expect((await diagnosisRow("fresh")).status).toBe("running");
      expect((await diagnosisRow("stale")).status).toBe("error");
    });

    it("reaper: another org's stale run is left to that org", async () => {
      await addDiagnosis("b-stale", "running", 120, null, "pdp", ORG_B);
      await store.reapStaleDiagnoses(ORG_A);
      expect((await diagnosisRow("b-stale")).status).toBe("running");
    });

    it("claim: marks running/verify, clears the error and dates the restart", async () => {
      await addDiagnosis("d1", "error", 24 * 60);
      await sql`UPDATE plan_ux_diagnoses SET error = 'x' WHERE id = 'd1'`.execute(
        database.db,
      );
      expect(await store.claimDiagnosisForVerify(ORG_A, "d1")).toBe(true);
      const r = await diagnosisRow("d1");
      expect(r.status).toBe("running");
      expect(r.stage).toBe("verify");
      expect(r.error).toBeNull();
      expect(r.restarted_at).toBeInstanceOf(Date);
    });

    it("claim: the second click loses", async () => {
      await addDiagnosis("d1", "done", 24 * 60);
      expect(await store.claimDiagnosisForVerify(ORG_A, "d1")).toBe(true);
      expect(await store.claimDiagnosisForVerify(ORG_A, "d1")).toBe(false);
    });

    it("claim: concurrent clicks, one wins", async () => {
      await addDiagnosis("d1", "done", 24 * 60);
      await addDiagnosis("d2", "done", 24 * 60);
      const results = await Promise.all([
        store.claimDiagnosisForVerify(ORG_A, "d1"),
        store.claimDiagnosisForVerify(ORG_A, "d1"),
        store.claimDiagnosisForVerify(ORG_A, "d2"),
        store.claimDiagnosisForVerify(ORG_A, "d2"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("claim: another diagnosis of the page running refuses; another page does not", async () => {
      await addDiagnosis("pdp-done", "done", 24 * 60);
      await addDiagnosis("pdp-running", "running", 5);
      await addDiagnosis("home-done", "done", 24 * 60, null, "home");
      expect(await store.claimDiagnosisForVerify(ORG_A, "pdp-done")).toBe(
        false,
      );
      expect((await diagnosisRow("pdp-done")).status).toBe("done");
      expect(await store.claimDiagnosisForVerify(ORG_A, "home-done")).toBe(
        true,
      );
    });

    it("running: the lock is per page", async () => {
      await addDiagnosis("home-running", "running", 5, null, "home");
      expect(await store.fetchRunningDiagnosis(ORG_A, "pdp")).toBeNull();
      expect((await store.fetchRunningDiagnosis(ORG_A, "home"))?.id).toBe(
        "home-running",
      );
      expect((await store.fetchRunningDiagnosis(ORG_A))?.id).toBe(
        "home-running",
      );
    });

    it("a rewrite returns to pending and clears the code 'after'", async () => {
      await addDiagnosis("d1", "done", 24 * 60);
      await sql`
        INSERT INTO plan_ux_hypotheses
          (id, organization_id, diagnosis_id, rank, title, status, code_status,
           code_note, code_before_url, code_after_url, code_diff, code_error,
           code_started_at, after_url, updated_at)
        VALUES ('h1', ${ORG_A}, 'd1', 1, 'velha', 'approved', 'done', 'n', 'b',
                'a', 'diff', 'e', now(), 'u', now())
      `.execute(database.db);
      await store.rewriteHypothesis(
        ORG_A,
        "h1",
        {
          title: "nova",
          why: "porquê",
          evidence_md: "ev",
          idea: "ideia",
          where: "onde",
          confidence: 0.6,
        },
        {
          verdict: "reescrita",
          summary: "s",
          runs: [],
          rewritten_from: { title: "velha", why: "" },
          verified_at: "2026-11-13T00:00:00Z",
        },
      );
      const h = await store.getHypothesis(ORG_A, "h1");
      expect(h?.title).toBe("nova");
      expect(h?.status).toBe("pending");
      expect(h?.verification?.verdict).toBe("reescrita");
      for (const key of [
        "code_status",
        "code_note",
        "code_before_url",
        "code_after_url",
        "code_diff",
        "code_error",
        "code_started_at",
        "after_url",
      ] as const) {
        expect(h?.[key]).toBeNull();
      }
    });
  });

  describe("opportunities and the hypothesis lifecycle", () => {
    async function seedFallen() {
      await addDiagnosis("d", "done", 60);
      await store.putOpportunityAt(ORG_A, "d", {
        ...opportunity,
        title: "Caiu",
      });
      await store.replaceOpportunityHypotheses(ORG_A, "d", "d:o1", [
        hypothesis,
      ]);
    }

    it("a new hypothesis is born 'gerada' and the lifecycle saves", async () => {
      await seedFallen();
      const [h] = await store.listHypotheses(ORG_A, "d");
      expect(h?.lifecycle).toBe("gerada");
      expect(h?.lifecycle_log?.[0]?.state).toBe("gerada");
      await store.saveHypothesisLifecycle(ORG_A, h?.id ?? "", {
        lifecycle: "refutada",
        lifecycle_log: [{ state: "refutada", at: "t", reason: "c1" }],
      });
      const [again] = await store.listHypotheses(ORG_A, "d");
      expect(again?.lifecycle).toBe("refutada");
    });

    it("retiring moves the opportunity and its hypotheses and frees the id for a reserve", async () => {
      await seedFallen();
      const outcome = {
        stop: "todas_descartadas" as const,
        retired: true,
        note: "x",
      };
      expect(
        await store.retireOpportunity(
          ORG_A,
          { id: "d:o1", title: "Caiu" },
          outcome,
        ),
      ).toBe(true);
      expect(
        (await store.listOpportunities(ORG_A, "d")).map((o) => [
          o.id,
          o.rank,
          o.outcome?.retired,
        ]),
      ).toEqual([[retiredId("d:o1"), 101, true]]);
      const [h] = await store.listHypotheses(ORG_A, "d");
      expect(h?.opportunity_id).toBe(retiredId("d:o1"));

      await store.putOpportunityAt(ORG_A, "d", {
        ...opportunity,
        area: "galeria",
        title: "Reserva",
      });
      expect(
        await store.retireOpportunity(
          ORG_A,
          { id: "d:o1", title: "Caiu" },
          outcome,
        ),
      ).toBe(false);
      expect(
        (await store.listOpportunities(ORG_A, "d")).map((o) => o.title).sort(),
      ).toEqual(["Caiu", "Reserva"]);
      const [moved] = await store.listHypotheses(ORG_A, "d");
      expect(moved?.id).toBe(`${retiredId("d:o1")}:h1`);
      await store.replaceOpportunityHypotheses(ORG_A, "d", "d:o1", [
        { ...hypothesis, title: "da reserva" },
      ]);
      expect(
        (await store.listHypotheses(ORG_A, "d")).map((x) => x.id).sort(),
      ).toEqual(["d:o1:h1", `${retiredId("d:o1")}:h1`]);
    });

    it("putting a reserve at a rank resets the previous outcome and tree notes", async () => {
      await seedFallen();
      await store.saveOpportunityOutcome(ORG_A, "d:o1", {
        stop: "todas_descartadas",
        retired: false,
        note: "x",
      });
      await store.saveOpportunityTreeNotes(ORG_A, "d:o1", [
        { category: "tecnologia", why: "sem erro" },
      ] as never);
      const replaced = await store.putOpportunityAt(ORG_A, "d", {
        ...opportunity,
        title: "Reserva",
      });
      expect(replaced.outcome).toBeNull();
      expect(replaced.tree_notes).toBeNull();
      expect(await store.listHypotheses(ORG_A, "d")).toEqual([]);
    });

    it("replacing opportunities clears every opportunity and hypothesis first", async () => {
      await seedFallen();
      const out = await store.replaceOpportunities(
        ORG_A,
        "d",
        [
          { ...opportunity, rank: 1, title: "Uma" },
          { ...opportunity, rank: 2, title: "Outra" },
        ],
        [{ ...hypothesis, kind: "nao_faria", title: "agora não" }],
      );
      expect(out.map((o) => [o.id, o.title])).toEqual([
        ["d:o1", "Uma"],
        ["d:o2", "Outra"],
      ]);
      expect(
        (await store.listHypotheses(ORG_A, "d")).map((h) => [h.id, h.kind]),
      ).toEqual([["d:n1", "nao_faria"]]);
    });

    it("appending continues the ranks and shifts the run's relations", async () => {
      await seedFallen();
      const tree = {
        relacoes: [{ rank: 1, tipo: "concorrente" }],
      } as unknown as NonNullable<typeof hypothesis & { tree: never }>["tree"];
      const ids = await store.appendOpportunityHypotheses(ORG_A, "d", "d:o1", [
        { ...hypothesis, tree },
        { ...hypothesis, rank: 2 },
      ]);
      expect(ids).toEqual(["d:o1:h2", "d:o1:h3"]);
      const appended = await store.getHypothesis(ORG_A, "d:o1:h2");
      expect(appended?.tree?.relacoes).toEqual([
        { rank: 2, tipo: "concorrente" },
      ] as never);
    });

    it("plan and review update priority and keep the lifecycle unless given", async () => {
      await seedFallen();
      const priority = { teste: 0.7 } as never;
      await store.saveHypothesisPlan(ORG_A, "d:o1:h1", {
        experiment: null,
        priority,
      });
      let h = await store.getHypothesis(ORG_A, "d:o1:h1");
      expect(h?.priority).toEqual(priority);
      expect(h?.lifecycle).toBe("gerada");
      await store.saveHypothesisReview(
        ORG_A,
        "d:o1:h1",
        {
          explica_o_gap: "nao",
          resposta: "r",
          falhas: [],
          reviewed_at: "t",
        },
        {
          priority: null,
          lifecycle: {
            lifecycle: "relevancia_avaliada",
            lifecycle_log: [],
          },
        },
      );
      h = await store.getHypothesis(ORG_A, "d:o1:h1");
      expect(h?.priority).toEqual(priority);
      expect(h?.review?.explica_o_gap).toBe("nao");
      expect(h?.lifecycle).toBe("relevancia_avaliada");
    });

    it("deleting an opportunity takes its hypotheses", async () => {
      await seedFallen();
      await store.deleteOpportunity(ORG_A, "d:o1");
      expect(await store.listOpportunities(ORG_A, "d")).toEqual([]);
      expect(await store.listHypotheses(ORG_A, "d")).toEqual([]);
    });
  });

  describe("benchmark cache", () => {
    const capture = {
      domain: "concorrente.example",
      url: "https://concorrente.example/p",
      screenshot_url: null,
      full_url: null,
      anatomy: { by_area: {} },
      captured_at: new Date().toISOString(),
    } as never;

    it("is per org and per page type, fresh for 30 days", async () => {
      await store.upsertBenchmark(ORG_A, capture);
      expect(
        (await store.getFreshBenchmark(ORG_A, "concorrente.example"))?.url,
      ).toBe("https://concorrente.example/p");
      expect(
        await store.getFreshBenchmark(ORG_B, "concorrente.example"),
      ).toBeNull();
      expect(
        await store.getFreshBenchmark(ORG_A, "concorrente.example", "home"),
      ).toBeNull();
      await store.upsertBenchmark(ORG_A, {
        ...(capture as object),
        captured_at: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      } as never);
      expect(
        await store.getFreshBenchmark(ORG_A, "concorrente.example"),
      ).toBeNull();
    });
  });
});
