/**
 * The Plan engine's read/write tools against real Postgres: the flag gate,
 * the permission check, tenancy, and the engine's output shapes, which the
 * Plan page reads unchanged.
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
import { checkApiKeyPermission } from "../../auth/api-key-permissions";
import { AccessControl } from "../../core/access-control";
import type { BoundAuthClient, StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import { CredentialVault } from "../../encryption/credential-vault";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { CURATED_KNOWLEDGE } from "../../plan-engine/knowledge/curated";
import type { OpportunityDraft } from "../../plan-engine/types";
import { AIProviderKeyStorage } from "../../storage/ai-provider-keys";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import {
  type HypothesisDraft,
  PlanEngineStorage,
} from "../../storage/plan-engine";
import { PlanEngineKnowledgeStorage } from "../../storage/plan-engine-knowledge";
import type { Permission } from "../../storage/types";
import { VirtualMCPStorage } from "../../storage/virtual";
import {
  PLAN_UX_DIAGNOSIS_GET,
  PLAN_UX_DIAGNOSIS_LIST,
  PLAN_UX_DOSSIER_GET,
  PLAN_UX_HYPOTHESIS_STATUS_UPDATE,
  PLAN_UX_KNOWLEDGE_ACTIVE_SET,
  PLAN_UX_KNOWLEDGE_LIST,
  PLAN_UX_KNOWLEDGE_UPSERT,
  PLAN_UX_OPPORTUNITY_GET,
  PLAN_UX_QUEUE_LIST,
  PLAN_UX_SITE_PROFILE_GET,
  PLAN_UX_SITE_PROFILE_UPDATE,
  PLAN_UX_SITE_RUN_GET,
  PLAN_UX_SITE_RUN_LIST,
  PLAN_UX_SITE_SOURCES_DETECT,
  PLAN_UX_STORE_VIEW,
} from "./index";

const ORG_A = "org_plan_tools_a";
const ORG_B = "org_plan_tools_b";
const USER_ID = "user_plan_tools";

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
  tree: {
    category: "ux",
    statement: "Se o seletor subir, então mais gente escolhe o tamanho",
    intervencao: "Subir o seletor",
    resultado: "mais carrinho no celular",
    mecanismo: "quem não vê o tamanho não escolhe",
    causa: "O seletor de tamanho fica abaixo da dobra",
    a_favor: [],
    contra: [],
    fontes_conhecimento: [CURATED_KNOWLEDGE[0]?.id ?? "", "inexistente"],
    segmento: "todos",
    metrica: { key: null, direcao: "sobe", efeito_esperado_pp: null },
    como_verificar: "abrir a PDP no celular",
    como_refutar: "o seletor já está na primeira tela",
    alvo: null,
    posicao_depois: "primeira_tela",
    relacoes: [],
    esforco: 1,
    testavel_na_pagina: true,
  },
};

describe("PLAN_UX tools", () => {
  let database: StudioDatabase;
  let planEngine: PlanEngineStorage;
  let planEngineKnowledge: PlanEngineKnowledgeStorage;
  let organizationSettings: OrganizationSettingsStorage;
  let virtualMcps: VirtualMCPStorage;
  let aiProviderKeys: AIProviderKeyStorage;

  type Principal = { kind: "member" } | { kind: "apiKey"; allow: Permission };

  function makeCtx(
    toolName: string,
    orgId = ORG_A,
    principal: Principal = { kind: "member" },
  ): StudioContext {
    const boundAuth = {
      isApiKeyPrincipal: principal.kind === "apiKey",
      hasPermission: async (requested: Permission) =>
        principal.kind === "apiKey"
          ? checkApiKeyPermission(principal.allow, requested)
          : true,
    } as unknown as BoundAuthClient;
    return {
      auth: {
        user: { id: USER_ID, email: "m@example.com", name: "M", role: "user" },
      },
      organization: { id: orgId, slug: orgId, name: orgId },
      access: new AccessControl(
        USER_ID,
        toolName,
        boundAuth,
        "user",
        "self",
        undefined,
        orgId,
      ),
      storage: {
        planEngine,
        planEngineKnowledge,
        organizationSettings,
        virtualMcps,
        aiProviderKeys,
      },
      aiProviders: { listModels: async () => [] },
    } as unknown as StudioContext;
  }

  const call = <I, O>(
    tool: {
      name: string;
      handler: (input: I, ctx: StudioContext) => Promise<O>;
    },
    input: I,
    orgId = ORG_A,
    principal?: Principal,
  ) => tool.handler(input, makeCtx(tool.name, orgId, principal));

  /** A finished PDP analysis of org A with one opportunity and one proposal. */
  async function seedAnalysis(goalId: string | null = null) {
    const d = await planEngine.insertDiagnosis(ORG_A, {
      domain: "www.loja.example",
      site_run_id: "run_1",
      goal_id: goalId,
      objective_statement: goalId ? "Vender mais no celular" : null,
    });
    await planEngine.updateDiagnosis(ORG_A, d.id, {
      status: "done",
      stage: "done",
      finished: true,
    });
    const o = await planEngine.putOpportunityAt(ORG_A, d.id, opportunity);
    await planEngine.replaceOpportunityHypotheses(ORG_A, d.id, o.id, [
      hypothesis,
    ]);
    const [h] = await planEngine.listHypotheses(ORG_A, d.id);
    if (!h) throw new Error("expected a hypothesis");
    return { d, o, h };
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER_ID}, 'm@example.com', false, 'M', ${now}, ${now})
    `.execute(database.db);
    for (const [id, slug] of [
      [ORG_A, "plan-tools-a"],
      [ORG_B, "plan-tools-b"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt: now })
        .execute();
    }
    planEngine = new PlanEngineStorage(database.db);
    planEngineKnowledge = new PlanEngineKnowledgeStorage(database.db);
    organizationSettings = new OrganizationSettingsStorage(database.db);
    virtualMcps = new VirtualMCPStorage(database.db);
    aiProviderKeys = new AIProviderKeyStorage(
      database.db,
      new CredentialVault(CredentialVault.generateKey()),
    );
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE plan_ux_site_profiles, plan_ux_diagnoses, plan_ux_opportunities,
               plan_ux_hypotheses, plan_ux_knowledge
    `.execute(database.db);
    await sql`DELETE FROM connections WHERE organization_id IN (${ORG_A}, ${ORG_B})`.execute(
      database.db,
    );
    for (const org of [ORG_A, ORG_B]) {
      await organizationSettings.upsert(org, {
        flags: { plan_page_enabled: true, plan_engine_native: true },
      });
    }
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  describe("gate", () => {
    it("refuses with plan_engine_native off, and with the Plan page off", async () => {
      await organizationSettings.upsert(ORG_A, {
        flags: { plan_engine_native: false },
      });
      await expect(call(PLAN_UX_STORE_VIEW, {})).rejects.toThrow(
        /^flag_off: .*plan_engine_native/,
      );
      await organizationSettings.upsert(ORG_A, {
        flags: { plan_page_enabled: false, plan_engine_native: true },
      });
      await expect(call(PLAN_UX_SITE_PROFILE_GET, {})).rejects.toThrow(
        /^flag_off: .*plan_page_enabled/,
      );
    });

    it("refuses a key that may not call the tool", async () => {
      const key: Principal = {
        kind: "apiKey",
        allow: { self: ["PLAN_UX_STORE_VIEW"] },
      };
      await expect(
        call(PLAN_UX_SITE_PROFILE_UPDATE, { domain: "x.example" }, ORG_A, key),
      ).rejects.toThrow(/Access denied/);
      expect(await call(PLAN_UX_STORE_VIEW, {}, ORG_A, key)).toMatchObject({
        pages: [],
      });
      expect(await planEngine.getSiteProfile(ORG_A)).toBeNull();
    });
  });

  describe("profile", () => {
    it("is null until a domain is set, then normalized", async () => {
      expect(await call(PLAN_UX_SITE_PROFILE_GET, {})).toEqual({
        profile: null,
      });
      const updated = await call(PLAN_UX_SITE_PROFILE_UPDATE, {
        domain: "https://WWW.Loja.example/produtos",
      });
      expect(updated).toMatchObject({
        profile: { domain: "www.loja.example", competitors: [] },
      });
      expect(await call(PLAN_UX_SITE_PROFILE_GET, {}, ORG_B)).toEqual({
        profile: null,
      });
    });

    it("answers bad input as the engine did, with the reason as data", async () => {
      expect(
        await call(PLAN_UX_SITE_PROFILE_UPDATE, { domain: "not a domain" }),
      ).toEqual({ error: "domínio inválido: not a domain" });
      expect(
        await call(PLAN_UX_SITE_PROFILE_UPDATE, {
          competitors: ["também não"],
        }),
      ).toEqual({
        error: "alguns concorrentes não responderam",
        rejected: [{ domain: "também não", reason: "domínio inválido" }],
      });
      expect(
        await call(PLAN_UX_SITE_PROFILE_UPDATE, {
          domain: "loja.example",
          code_repo: "sem-barra",
        }),
      ).toEqual({ error: "repo inválido (use owner/nome): sem-barra" });
      expect(
        await call(PLAN_UX_SITE_PROFILE_UPDATE, { studio_site: "x" }),
      ).toMatchObject({ error: expect.stringMatching(/domain is required/) });
    });

    it("detects the store from the org's site project, and only this org's", async () => {
      await virtualMcps.create(ORG_A, USER_ID, {
        title: "Loja",
        description: null,
        icon: null,
        status: "active",
        pinned: false,
        metadata: {
          siteSlug: "loja",
          productionUrl: "https://www.loja.example/",
          repository: {
            owner: "acme",
            name: "loja",
            url: "https://github.com/acme/loja",
          },
        },
        connections: [],
      } as never);
      const out = (await call(PLAN_UX_SITE_SOURCES_DETECT, {})) as {
        profile: { domain: string; studio_site: string | null } | null;
        sources: { repository: { owner: string } | null } | null;
      };
      expect(out.profile?.domain).toBe("www.loja.example");
      expect(out.profile?.studio_site).toBe("loja");
      expect(out.sources?.repository?.owner).toBe("acme");
      expect(await call(PLAN_UX_SITE_SOURCES_DETECT, {}, ORG_B)).toMatchObject({
        profile: null,
        sources: {
          studio_project: null,
          errors: ["nenhum projeto de site nesta org do Studio"],
        },
      });
    });
  });

  describe("reading analyses", () => {
    it("the store view has the page, the loss and its hypotheses", async () => {
      await call(PLAN_UX_SITE_PROFILE_UPDATE, { domain: "www.loja.example" });
      const { d, o, h } = await seedAnalysis("goal_1");
      const view = (await call(PLAN_UX_STORE_VIEW, { goal_id: "goal_1" })) as {
        pages: Array<{ page_type: string; diagnosis_id: string }>;
        top: Array<{ id: string; hypotheses: Array<{ id: string }> }>;
        running: boolean;
        setup?: {
          current: { domain: string | null };
          needs: Array<{ key: string; blocking: boolean }>;
        };
      };
      expect(view.pages.map((p) => [p.page_type, p.diagnosis_id])).toEqual([
        ["pdp", d.id],
      ]);
      expect(view.top.map((t) => t.id)).toEqual([o.id]);
      expect(view.top[0]?.hypotheses.map((x) => x.id)).toEqual([h.id]);
      expect(view.running).toBe(false);
      expect(view.setup?.current.domain).toBe("www.loja.example");
      // Org A has no AI provider: setup asks for one.
      expect(view.setup?.needs).toContainEqual({
        key: "ai_provider",
        blocking: true,
      });
      expect(
        await call(PLAN_UX_STORE_VIEW, { goal_id: "other" }),
      ).toMatchObject({ pages: [], top: [], others: [] });
      expect(await call(PLAN_UX_STORE_VIEW, {}, ORG_B)).toMatchObject({
        pages: [],
        top: [],
      });
    });

    it("the store view asks for an AI provider only while the org has no model", async () => {
      const needsOf = async () =>
        (
          (await call(PLAN_UX_STORE_VIEW, {}, ORG_B)) as {
            setup: { needs: Array<{ key: string }> };
          }
        ).setup.needs.map((n) => n.key);
      expect(await needsOf()).toEqual(["domain", "ai_provider"]);
      const key = await aiProviderKeys.create({
        providerId: "openrouter",
        label: "test",
        apiKey: "sk-test",
        organizationId: ORG_B,
        createdBy: USER_ID,
      });
      await organizationSettings.upsert(ORG_B, {
        simple_mode: {
          tiers: {
            fast: null,
            smart: { keyId: key.id, modelId: "anthropic/claude-sonnet-5.5" },
            thinking: null,
            image: null,
            web_search: null,
            deep_research: null,
          },
        },
      });
      try {
        expect(await needsOf()).toEqual(["domain"]);
      } finally {
        await aiProviderKeys.delete(key.id, ORG_B);
      }
    });

    it("an opportunity comes with its hypotheses' lifecycle and the citations that exist", async () => {
      const { o, h } = await seedAnalysis();
      const out = (await call(PLAN_UX_OPPORTUNITY_GET, {
        opportunity_id: o.id,
      })) as {
        opportunity: {
          id: string;
          page_type: string;
          hypotheses: Array<{
            id: string;
            lifecycle: string;
            experiment: unknown;
            review: unknown;
            relevance: unknown;
            citations: Array<{ id: string }>;
          }>;
        };
      };
      expect(out.opportunity.id).toBe(o.id);
      expect(out.opportunity.page_type).toBe("pdp");
      const [detail] = out.opportunity.hypotheses;
      expect(detail?.id).toBe(h.id);
      expect(detail?.lifecycle).toBe("gerada");
      expect(detail?.experiment).toBeNull();
      expect(detail?.citations.map((c) => c.id)).toEqual([
        CURATED_KNOWLEDGE[0]?.id ?? "",
      ]);
      expect(
        await call(PLAN_UX_OPPORTUNITY_GET, { opportunity_id: o.id }, ORG_B),
      ).toEqual({ error: "oportunidade não encontrada" });
    });

    it("a diagnosis carries each proposal's dossier; the dossier reads alone", async () => {
      const { d, h } = await seedAnalysis();
      const out = (await call(PLAN_UX_DIAGNOSIS_GET, {
        diagnosis_id: d.id,
      })) as {
        format: string;
        hypotheses: Array<{ id: string; dossier_md?: string }>;
      };
      expect(out).toMatchObject({ format: "v2" });
      expect(out.hypotheses[0]?.dossier_md).toContain(h.title);
      const dossier = (await call(PLAN_UX_DOSSIER_GET, {
        hypothesis_id: h.id,
      })) as { markdown: string };
      expect(dossier.markdown).toBe(out.hypotheses[0]?.dossier_md ?? "");
      expect(
        await call(PLAN_UX_DIAGNOSIS_GET, { diagnosis_id: d.id }, ORG_B),
      ).toEqual({ error: "diagnóstico não encontrado" });
    });

    it("lists diagnoses and runs, and reads a run's opportunities", async () => {
      const { d, o } = await seedAnalysis("goal_1");
      expect(await call(PLAN_UX_DIAGNOSIS_LIST, {})).toMatchObject({
        diagnoses: [{ id: d.id, opportunities_total: 1, hypotheses_total: 1 }],
      });
      expect(await call(PLAN_UX_SITE_RUN_LIST, { goal_id: "goal_1" })).toEqual({
        runs: [
          {
            site_run_id: "run_1",
            goal_id: "goal_1",
            objective_statement: "Vender mais no celular",
            started_at: d.started_at,
            status: "done",
            pages: ["pdp"],
          },
        ],
      });
      expect(
        await call(PLAN_UX_SITE_RUN_GET, { site_run_id: "run_1" }),
      ).toMatchObject({
        site_run_id: "run_1",
        opportunities: [{ id: o.id, page_type: "pdp" }],
        hidden_elsewhere: 0,
      });
      expect(
        await call(PLAN_UX_SITE_RUN_GET, { site_run_id: "run_1" }, ORG_B),
      ).toEqual({ error: "rodada do site não encontrada" });
    });

    it("closes this org's abandoned run when reading", async () => {
      await sql`
        INSERT INTO plan_ux_diagnoses
          (id, organization_id, status, domain, started_at)
        VALUES ('stale', ${ORG_A}, 'running', 'x', now() - interval '3 hours')
      `.execute(database.db);
      const out = (await call(PLAN_UX_DIAGNOSIS_LIST, {})) as {
        diagnoses: Array<{ id: string; status: string }>;
      };
      expect(out.diagnoses).toMatchObject([{ id: "stale", status: "error" }]);
    });
  });

  describe("deciding hypotheses", () => {
    it("refuses to approve a hypothesis that is not ready", async () => {
      const { h } = await seedAnalysis();
      expect(
        await call(PLAN_UX_HYPOTHESIS_STATUS_UPDATE, {
          hypothesis_id: h.id,
          status: "approved",
        }),
      ).toMatchObject({ error: expect.stringMatching(/^Só dá pra aprovar/) });
      expect((await planEngine.getHypothesis(ORG_A, h.id))?.status).toBe(
        "pending",
      );
    });

    it("a dismissal becomes the store's knowledge; back to pending turns it off", async () => {
      const { h } = await seedAnalysis();
      const out = await call(PLAN_UX_HYPOTHESIS_STATUS_UPDATE, {
        hypothesis_id: h.id,
        status: "dismissed",
        note: "  já testamos  ",
      });
      expect(out).toMatchObject({
        hypothesis: {
          id: h.id,
          status: "dismissed",
          status_note: "já testamos",
        },
      });
      const learned = await planEngineKnowledge.getKnowledge(
        ORG_A,
        `decisao:${h.id}`,
      );
      expect(learned?.active).toBe(true);
      await call(PLAN_UX_HYPOTHESIS_STATUS_UPDATE, {
        hypothesis_id: h.id,
        status: "pending",
      });
      expect(
        (await planEngineKnowledge.getKnowledge(ORG_A, `decisao:${h.id}`))
          ?.active,
      ).toBe(false);
    });

    it("org B cannot decide org A's hypothesis", async () => {
      const { h } = await seedAnalysis();
      expect(
        await call(
          PLAN_UX_HYPOTHESIS_STATUS_UPDATE,
          { hypothesis_id: h.id, status: "dismissed" },
          ORG_B,
        ),
      ).toEqual({ error: "hipótese não encontrada" });
      expect((await planEngine.getHypothesis(ORG_A, h.id))?.status).toBe(
        "pending",
      );
    });

    it("the queue lists approved proposals with their opportunity", async () => {
      const { o, h } = await seedAnalysis();
      expect(await call(PLAN_UX_QUEUE_LIST, {})).toEqual({ hypotheses: [] });
      await planEngine.setHypothesisStatus(ORG_A, h.id, "approved", null);
      expect(await call(PLAN_UX_QUEUE_LIST, {})).toMatchObject({
        hypotheses: [{ id: h.id, opportunity_title: o.title }],
      });
      expect(await call(PLAN_UX_QUEUE_LIST, {}, ORG_B)).toEqual({
        hypotheses: [],
      });
    });
  });

  describe("knowledge", () => {
    const entry = {
      conhecimento: "Frete grátis acima de um valor subiu o ticket",
      categoria: "comercial" as const,
      fonte: "Teste A/B da loja",
      tipo_fonte: "ab_desta_loja" as const,
    };

    it("adds, lists with the curated, and turns an entry off", async () => {
      const saved = (await call(PLAN_UX_KNOWLEDGE_UPSERT, { entry })) as {
        entry: { id: string; active: boolean; origem: string };
      };
      expect(saved.entry).toMatchObject({ active: true, origem: "manual" });
      const list = (await call(PLAN_UX_KNOWLEDGE_LIST, {})) as {
        store: Array<{ id: string }>;
        curated: Array<{ id: string; artigo: unknown }>;
        publishers: unknown[];
      };
      expect(list.store.map((e) => e.id)).toEqual([saved.entry.id]);
      expect(list.curated).toHaveLength(CURATED_KNOWLEDGE.length);
      expect(list.publishers.length).toBeGreaterThan(0);
      expect(
        await call(PLAN_UX_KNOWLEDGE_ACTIVE_SET, {
          id: saved.entry.id,
          active: false,
        }),
      ).toMatchObject({ entry: { active: false } });
    });

    it("needs a link for a study, edits only this org's manual entries", async () => {
      expect(
        await call(PLAN_UX_KNOWLEDGE_UPSERT, {
          entry: { ...entry, tipo_fonte: "estudo" },
        }),
      ).toEqual({
        error: '"estudo" precisa de fonte_url https (o link pra fonte).',
      });
      expect(
        await call(PLAN_UX_KNOWLEDGE_UPSERT, { id: "decisao:x", entry }),
      ).toMatchObject({ error: expect.stringMatching(/só entradas manuais/) });
      const saved = (await call(PLAN_UX_KNOWLEDGE_UPSERT, { entry })) as {
        entry: { id: string };
      };
      expect(
        await call(
          PLAN_UX_KNOWLEDGE_UPSERT,
          { id: saved.entry.id, entry },
          ORG_B,
        ),
      ).toEqual({ error: "entrada não encontrada" });
      expect(
        await call(
          PLAN_UX_KNOWLEDGE_ACTIVE_SET,
          { id: saved.entry.id, active: false },
          ORG_B,
        ),
      ).toEqual({ error: "entrada não encontrada" });
    });
  });
});
