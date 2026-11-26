/**
 * Starting and re-verifying a diagnosis against real Postgres and a real DBOS
 * executor: the tools' refusals and locks, and the workflow's steps end to
 * end. The model is the only stand-in, at the provider boundary.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "kysely";
import { AccessControl } from "../../core/access-control";
import type { BoundAuthClient, StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { buildDbosConfig } from "../../dbos/config";
import { CredentialVault } from "../../encryption/credential-vault";
import { registerPlanUxDiagnosisWorkflow } from "../../plan-engine/dbos-ux-diagnosis";
import { evidence } from "../../plan-engine/fixtures/evidence";
import { NO_AI_MODEL } from "../../plan-engine/ports";
import { setPlanEngineContextFactory } from "../../plan-engine/run/engine-run";
import type { OpportunityDraft } from "../../plan-engine/types";
import { AIProviderKeyStorage } from "../../storage/ai-provider-keys";
import { ConnectionStorage } from "../../storage/connection";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { OrgSiteStorage } from "../../storage/org-sites";
import {
  type HypothesisDraft,
  PlanEngineStorage,
} from "../../storage/plan-engine";
import { PlanEngineCostStorage } from "../../storage/plan-engine-costs";
import { PlanEngineKnowledgeStorage } from "../../storage/plan-engine-knowledge";
import { VirtualMCPStorage } from "../../storage/virtual";
import { PLAN_UX_DIAGNOSIS_START, PLAN_UX_HYPOTHESES_VERIFY } from "./index";

const ORG = "org_plan_runs_a";
const OTHER = "org_plan_runs_b";
const USER_ID = "user_plan_runs";

const PLAN_ANSWER = JSON.stringify({
  checks: [
    {
      claim: "o seletor fica abaixo da dobra",
      stage: "live",
      device: "mobile",
      steps: [{ op: "open" }],
      confirms_if: "y maior que a altura da tela",
      refutes_if: "y menor que a altura da tela",
    },
    {
      claim: "o código esconde o seletor",
      stage: "repo",
      device: "mobile",
      question: "o seletor some sem estoque?",
      confirms_if: "sim",
      refutes_if: "não",
    },
  ],
});
const JUDGE_ANSWER = JSON.stringify({
  verdict: "inconclusiva",
  summary: "Nenhum teste rodou.",
  runs: [],
});

const NO_TIERS = {
  fast: null,
  smart: null,
  thinking: null,
  image: null,
  web_search: null,
  deep_research: null,
};

const opportunity: OpportunityDraft = {
  rank: 1,
  area: "tamanho",
  title: "No celular, 8% de quem vê o produto põe no carrinho",
  summary: "",
  device: "mobile",
  sources: [],
  money: null,
  confidence: 0.6,
};

const hypothesis: HypothesisDraft = {
  kind: "proposta",
  rank: 1,
  opportunity_id: null,
  title: "O seletor de tamanho fica abaixo da dobra",
  device: "mobile",
  evidence_md: "",
  idea: "Subir o seletor",
  why: "Quem não vê o tamanho não escolhe",
  where: "PDP",
  money: null,
  confidence: 0.5,
  benchmark_refs: [],
  benchmark: [],
  before_url: null,
  category: "ux",
  tree: null,
};

describe("PLAN_UX run tools and planUxDiagnosisWorkflow", () => {
  let database: StudioDatabase;
  let planEngine: PlanEngineStorage;
  let organizationSettings: OrganizationSettingsStorage;
  let storage: Record<string, unknown>;
  let keyId = "";
  let dropModelOnRun: string | null = null;
  const prompts: string[] = [];

  /** The model at the provider boundary: answers by which step is asking. */
  const model = () =>
    new MockLanguageModelV4({
      doGenerate: async (options) => {
        const system = options.prompt.find((m) => m.role === "system");
        const text = String(system?.content ?? "");
        prompts.push(text.slice(0, 40));
        return {
          content: [
            {
              type: "text",
              text: text.includes("VERIFICAÇÃO") ? PLAN_ANSWER : JUDGE_ANSWER,
            },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 100,
              noCache: 100,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
          providerMetadata: { openrouter: { usage: { cost: 0.01 } } },
          warnings: [],
        };
      },
    });

  function makeCtx(orgId = ORG): StudioContext {
    const boundAuth = {
      isApiKeyPrincipal: false,
      hasPermission: async () => true,
    } as unknown as BoundAuthClient;
    return {
      auth: { user: { id: USER_ID, role: "user" } },
      organization: { id: orgId, slug: orgId, name: orgId },
      access: new AccessControl(
        USER_ID,
        "PLAN_UX",
        boundAuth,
        "user",
        "self",
        undefined,
        orgId,
      ),
      storage,
      aiProviders: {
        listModels: async () => [],
        activate: async () => ({
          info: { id: "openrouter" },
          aiSdk: { languageModel: model },
        }),
      },
      objectStorage: null,
    } as unknown as StudioContext;
  }

  const waitFor = (workflowId: string) =>
    DBOS.retrieveWorkflow(workflowId).getResult();

  async function seedFinishedDiagnosis(org = ORG) {
    await planEngine.upsertSiteProfile(org, { domain: "loja.example" });
    const d = await planEngine.insertDiagnosis(org, {
      domain: "loja.example",
      site_run_id: "run_1",
    });
    await planEngine.updateDiagnosis(org, d.id, {
      status: "done",
      stage: "done",
      finished: true,
      evidence: evidence(),
      summary: { headline: "h", limits: [] },
      cost_usd: 0.5,
    });
    const o = await planEngine.putOpportunityAt(org, d.id, opportunity);
    await planEngine.replaceOpportunityHypotheses(org, d.id, o.id, [
      hypothesis,
    ]);
    const [h] = await planEngine.listHypotheses(org, d.id);
    if (!h) throw new Error("expected a hypothesis");
    return { d, o, h };
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER_ID}, 'r@example.com', false, 'R', ${now}, ${now})
    `.execute(database.db);
    for (const id of [ORG, OTHER]) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug: id, createdAt: now })
        .execute();
    }
    const vault = new CredentialVault(CredentialVault.generateKey());
    planEngine = new PlanEngineStorage(database.db);
    organizationSettings = new OrganizationSettingsStorage(database.db);
    const aiProviderKeys = new AIProviderKeyStorage(database.db, vault);
    keyId = (
      await aiProviderKeys.create({
        providerId: "openrouter",
        label: "test",
        apiKey: "sk-test",
        organizationId: ORG,
        createdBy: USER_ID,
      })
    ).id;
    storage = {
      planEngine,
      planEngineKnowledge: new PlanEngineKnowledgeStorage(database.db),
      planEngineCosts: new PlanEngineCostStorage(database.db),
      organizationSettings,
      aiProviderKeys,
      connections: new ConnectionStorage(database.db, vault),
      orgSites: new OrgSiteStorage(database.db),
      virtualMcps: new VirtualMCPStorage(database.db),
    };

    DBOS.setConfig(
      buildDbosConfig({
        systemDatabaseUrl:
          process.env.DATABASE_URL ??
          "postgresql://postgres:postgres@localhost:5432/postgres",
        poolSize: 4,
        executorID: undefined,
      }),
    );
    registerPlanUxDiagnosisWorkflow();
    await DBOS.launch();
    setPlanEngineContextFactory(async (orgId, userId) => {
      if (userId !== USER_ID) return null;
      // The org loses its model after the tool's preflight, as the run opens.
      if (orgId === dropModelOnRun) {
        await organizationSettings.upsert(orgId, {
          flags: { plan_page_enabled: true, plan_engine_native: true },
          simple_mode: { tiers: NO_TIERS },
        });
      }
      return makeCtx(orgId);
    });
  });

  beforeEach(async () => {
    prompts.length = 0;
    dropModelOnRun = null;
    await sql`
      TRUNCATE plan_ux_site_profiles, plan_ux_diagnoses, plan_ux_opportunities,
               plan_ux_hypotheses, plan_ux_knowledge, plan_cost_events
    `.execute(database.db);
    for (const org of [ORG, OTHER]) {
      await organizationSettings.upsert(org, {
        flags: { plan_page_enabled: true, plan_engine_native: true },
        simple_mode: {
          tiers: {
            fast: null,
            smart: { keyId, modelId: "anthropic/claude-sonnet-5.5" },
            thinking: null,
            image: null,
            web_search: null,
            deep_research: null,
          },
        },
      });
    }
  });

  afterAll(async () => {
    await DBOS.shutdown();
    await closeTestPgDatabase(database);
  });

  /** What a refused start or verification left behind for `org`. */
  async function spendOf(org: string) {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM plan_cost_events WHERE organization_id = ${org}
    `.execute(database.db);
    return rows;
  }

  describe("an org with no AI provider", () => {
    const refusal = {
      status: "error" as const,
      error: NO_AI_MODEL,
      needs: [{ key: "ai_provider", blocking: true }],
    };

    it("a diagnosis start creates no run and spends nothing", async () => {
      // OTHER has no provider key: its smart slot points at ORG's key.
      await planEngine.upsertSiteProfile(OTHER, { domain: "loja.example" });
      const out = await PLAN_UX_DIAGNOSIS_START.handler(
        { todas: true },
        makeCtx(OTHER),
      );
      expect(out).toEqual(refusal);
      expect(await planEngine.listDiagnoses(OTHER)).toEqual([]);
      expect(await planEngine.listSiteRuns(OTHER, { limit: 20 })).toEqual([]);
      expect(await spendOf(OTHER)).toEqual([]);
      expect(prompts).toEqual([]);
    });

    it("verifying again leaves the diagnosis as it was and spends nothing", async () => {
      const { d } = await seedFinishedDiagnosis(OTHER);
      const out = await PLAN_UX_HYPOTHESES_VERIFY.handler(
        { diagnosis_id: d.id },
        makeCtx(OTHER),
      );
      expect(out).toEqual(refusal);
      const after = await planEngine.getDiagnosis(OTHER, d.id);
      expect(after?.status).toBe("done");
      expect(after?.stage).toBe("done");
      expect(await spendOf(OTHER)).toEqual([]);
      expect(prompts).toEqual([]);
    });

    it("a model lost mid-run ends it with the same message and the provider gap", async () => {
      const { d } = await seedFinishedDiagnosis();
      dropModelOnRun = ORG;
      const out = await PLAN_UX_HYPOTHESES_VERIFY.handler(
        { diagnosis_id: d.id },
        makeCtx(),
      );
      if (out.status !== "running") throw new Error(JSON.stringify(out));
      await expect(waitFor(out.instance_id)).rejects.toThrow(NO_AI_MODEL);

      const after = await planEngine.getDiagnosis(ORG, d.id);
      expect(after?.status).toBe("done");
      expect(after?.summary?.limits).toEqual([
        `A verificação de novo falhou: ${NO_AI_MODEL}`,
      ]);
      expect(after?.evidence?.gaps).toContainEqual({
        source: "studio",
        error: NO_AI_MODEL,
        owner: "customer",
        key: "ai_provider",
      });
      expect(prompts).toEqual([]);
      expect(await spendOf(ORG)).toEqual([]);
    }, 60_000);
  });

  describe("PLAN_UX_DIAGNOSIS_START", () => {
    it("refuses with plan_engine_native off", async () => {
      await organizationSettings.upsert(ORG, {
        flags: { plan_page_enabled: true, plan_engine_native: false },
      });
      await expect(
        PLAN_UX_DIAGNOSIS_START.handler({}, makeCtx()),
      ).rejects.toThrow(/^flag_off: .*plan_engine_native/);
    });

    it("answers invalid input as data, like the engine", async () => {
      const out = await PLAN_UX_DIAGNOSIS_START.handler(
        { pages: ["pdp", "pdp"] },
        makeCtx(),
      );
      expect(out).toEqual({
        status: "error",
        error: "entrada inválida: pages: páginas repetidas",
      });
    });

    it("asks for the domain when the store is unknown", async () => {
      const out = await PLAN_UX_DIAGNOSIS_START.handler({}, makeCtx());
      expect(out.status).toBe("error");
      expect(out).toMatchObject({ needs_domain: true });
    });

    it("refuses past the daily cap, counting every page of the run", async () => {
      await planEngine.upsertSiteProfile(ORG, { domain: "loja.example" });
      for (let i = 0; i < 9; i++) {
        const d = await planEngine.insertDiagnosis(ORG, {
          domain: "loja.example",
        });
        await planEngine.updateDiagnosis(ORG, d.id, { status: "done" });
      }
      const out = await PLAN_UX_DIAGNOSIS_START.handler(
        { pages: ["home", "pdp"] },
        makeCtx(),
      );
      expect(out).toEqual({
        status: "error",
        error: "limite diário de análises atingido",
      });
    });

    it("a page already running comes back as it is", async () => {
      await planEngine.upsertSiteProfile(ORG, { domain: "loja.example" });
      const running = await planEngine.insertDiagnosis(ORG, {
        domain: "loja.example",
        page_type: "pdp",
        site_run_id: "run_old",
      });
      const out = await PLAN_UX_DIAGNOSIS_START.handler(
        { page_type: "pdp" },
        makeCtx(),
      );
      expect(out).toEqual({
        status: "started",
        site_run_id: "run_old",
        diagnoses: [
          { page_type: "pdp", diagnosis_id: running.id, already_running: true },
        ],
      });
    });

    it("runs the workflow to the end and records the named gaps", async () => {
      await planEngine.upsertSiteProfile(ORG, { domain: "loja.example" });
      const out = await PLAN_UX_DIAGNOSIS_START.handler(
        { page_type: "pdp", objective_statement: " Vender mais " },
        makeCtx(),
      );
      if (out.status !== "started") throw new Error(JSON.stringify(out));
      const [started] = out.diagnoses;
      if (!started) throw new Error("expected a diagnosis");
      expect(started.already_running).toBe(false);
      await waitFor(`plan-ux-diagnosis:${started.diagnosis_id}`);

      const d = await planEngine.getDiagnosis(ORG, started.diagnosis_id);
      expect(d?.status).toBe("done");
      expect(d?.stage).toBe("done");
      expect(d?.objective_statement).toBe("Vender mais");
      const gaps = d?.evidence?.gaps ?? [];
      expect(gaps).toContainEqual({
        source: "bigquery",
        error: "BigQuery não configurado na app",
      });
      expect(gaps).toContainEqual({
        source: "browser",
        error: "navegador indisponível nesta instalação",
      });
      expect(gaps.find((g) => g.source === "github")?.owner).toBe("customer");
      expect(gaps.some((g) => g.source === "lake")).toBe(true);
      expect(gaps.some((g) => g.source === "heatmap")).toBe(true);
      // A tenant's run never reads or writes another's rows.
      expect(await planEngine.listDiagnoses(OTHER)).toEqual([]);
    }, 60_000);

    it("with the browser flag on but no hosted sandboxes, keeps the named gap and finishes", async () => {
      await organizationSettings.upsert(ORG, {
        flags: {
          plan_page_enabled: true,
          plan_engine_native: true,
          plan_engine_browser: true,
        },
      });
      await planEngine.upsertSiteProfile(ORG, { domain: "loja.example" });
      const out = await PLAN_UX_DIAGNOSIS_START.handler(
        { page_type: "pdp" },
        makeCtx(),
      );
      if (out.status !== "started") throw new Error(JSON.stringify(out));
      const [started] = out.diagnoses;
      if (!started) throw new Error("expected a diagnosis");
      await waitFor(`plan-ux-diagnosis:${started.diagnosis_id}`);
      const d = await planEngine.getDiagnosis(ORG, started.diagnosis_id);
      expect(d?.status).toBe("done");
      expect(d?.evidence?.gaps).toContainEqual({
        source: "browser",
        error: "navegador indisponível nesta instalação",
      });
      expect(d?.evidence?.captures).toEqual([]);
      expect(d?.evidence?.probes).toBeUndefined();
    }, 60_000);
  });

  describe("PLAN_UX_HYPOTHESES_VERIFY", () => {
    it("refuses an unknown diagnosis and one still running", async () => {
      expect(
        await PLAN_UX_HYPOTHESES_VERIFY.handler(
          { diagnosis_id: "nope" },
          makeCtx(),
        ),
      ).toEqual({ status: "error", error: "diagnóstico não encontrado" });
      const { d } = await seedFinishedDiagnosis();
      await planEngine.updateDiagnosis(ORG, d.id, { status: "running" });
      expect(
        await PLAN_UX_HYPOTHESES_VERIFY.handler(
          { diagnosis_id: d.id },
          makeCtx(),
        ),
      ).toEqual({
        status: "error",
        error: "o diagnóstico ainda está rodando: espere ele terminar",
      });
    });

    it("leaves an approved hypothesis as it is", async () => {
      const { d, h } = await seedFinishedDiagnosis();
      await planEngine.setHypothesisStatus(ORG, h.id, "approved", null);
      const out = await PLAN_UX_HYPOTHESES_VERIFY.handler(
        { diagnosis_id: d.id, hypothesis_id: h.id },
        makeCtx(),
      );
      expect(out.status).toBe("error");
      expect(out).toMatchObject({
        error: expect.stringContaining("já foi aprovada"),
      });
    });

    it("another org's diagnosis is not found", async () => {
      const { d } = await seedFinishedDiagnosis();
      expect(
        await PLAN_UX_HYPOTHESES_VERIFY.handler(
          { diagnosis_id: d.id },
          makeCtx(OTHER),
        ),
      ).toEqual({ status: "error", error: "diagnóstico não encontrado" });
    });

    it("verifies again with the model, records what it cost, and returns to done", async () => {
      const { d, h } = await seedFinishedDiagnosis();
      const out = await PLAN_UX_HYPOTHESES_VERIFY.handler(
        { diagnosis_id: d.id },
        makeCtx(),
      );
      if (out.status !== "running") throw new Error(JSON.stringify(out));
      expect(out.hypotheses).toBe(1);
      expect(out.skipped).toBe(0);
      expect(out.repo_snapshot).toStartWith("código indisponível:");
      // A second click while it runs loses the lock.
      expect(
        (
          await PLAN_UX_HYPOTHESES_VERIFY.handler(
            { diagnosis_id: d.id },
            makeCtx(),
          )
        ).status,
      ).toBe("error");
      await waitFor(out.instance_id);

      const after = await planEngine.getDiagnosis(ORG, d.id);
      expect(after?.status).toBe("done");
      const verified = await planEngine.getHypothesis(ORG, h.id);
      expect(verified?.verification?.verdict).toBe("inconclusiva");
      const observed = (verified?.verification?.runs ?? []).map(
        (r) => r.observed,
      );
      expect(observed).toEqual([
        "o repositório não foi lido nesta rodada",
        "navegador indisponível nesta instalação",
      ]);
      expect(prompts).toHaveLength(2);
      const { rows } = await sql<{ id: string; cost_usd: number }>`
        SELECT id, cost_usd FROM plan_cost_events WHERE organization_id = ${ORG}
      `.execute(database.db);
      expect(rows.map((r) => r.id).sort()).toEqual([
        `ux:${d.id}:verify:${h.id}:${out.instance_id.split(":").pop()}:c0`,
        `ux:${d.id}:verify:${h.id}:${out.instance_id.split(":").pop()}:c1`,
      ]);
      expect(after?.cost_usd).toBeCloseTo(0.52, 6);
    }, 60_000);
  });
});
