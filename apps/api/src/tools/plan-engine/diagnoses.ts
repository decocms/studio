/**
 * Reading the Plan engine's analyses and deciding their hypotheses. Starting
 * or re-verifying an analysis is not here: it runs work.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import type { StudioContext } from "@/core/studio-context";
import {
  citationOf,
  type GetUxOpportunityOutput,
  type ListUxSiteRunsOutput,
  type UpdateUxHypothesisStatusOutput,
} from "@/plan-engine/contract";
import { buildDossier } from "@/plan-engine/dossier";
import { factBook } from "@/plan-engine/facts";
import { CURATED_KNOWLEDGE } from "@/plan-engine/knowledge/curated";
import { fromDecision, learnedId } from "@/plan-engine/knowledge/learn";
import {
  canApprove,
  LIFECYCLE_WORD,
  lifecycleOf,
} from "@/plan-engine/lifecycle";
import { queueOrder } from "@/plan-engine/priority";
import {
  buildStoreView,
  byValue,
  choosePageDiagnoses,
  coveredElsewhere,
} from "@/plan-engine/store-view";
import type { UxDiagnosis, UxHypothesis } from "@/plan-engine/types";
import { legacyOpportunities } from "@/storage/plan-engine";
import { engineOrg, engineOutput, errorOf, READ, Row, WRITE } from "./gate";

const IdSchema = z.string().min(1).max(256);

const GoalIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("Only the runs started toward this Plan goal");

const SiteRunSchema = z.object({
  site_run_id: z.string(),
  goal_id: z.string().nullable(),
  objective_statement: z.string().nullable(),
  started_at: z.string(),
  status: z.enum(["running", "done", "error"]),
  pages: z.array(
    z.enum(["home", "categoria", "busca", "pdp", "carrinho_checkout"]),
  ),
});

export const PLAN_UX_DIAGNOSIS_GET = defineTool({
  name: "PLAN_UX_DIAGNOSIS_GET",
  description:
    "One store diagnosis: its evidence, the analysed page's opportunities and each one's hypotheses (and progress while it runs). `format` is v1 for diagnoses from before opportunities existed.",
  annotations: { title: "Get Store Diagnosis", ...READ },
  inputSchema: z.object({ diagnosis_id: IdSchema }),
  outputSchema: engineOutput(
    z.object({
      diagnosis: Row,
      format: z.enum(["v1", "v2"]),
      opportunities: z.array(Row),
      hypotheses: z.array(Row),
    }),
  ),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      const diagnosis = await store.getDiagnosis(org.id, input.diagnosis_id);
      if (!diagnosis) return { error: "diagnóstico não encontrado" };
      const [opportunities, hypotheses] = await Promise.all([
        store.listOpportunities(org.id, input.diagnosis_id),
        store.listHypotheses(org.id, input.diagnosis_id),
      ]);
      const legacy =
        opportunities.length === 0 &&
        hypotheses.some((h) => h.kind === "proposta");
      if (legacy) {
        return {
          diagnosis,
          format: "v1" as const,
          ...legacyOpportunities(hypotheses),
        };
      }
      const oppOf = new Map(opportunities.map((o) => [o.id, o]));
      const facts = diagnosis.evidence
        ? factBook(diagnosis.evidence)
        : undefined;
      return {
        diagnosis,
        format: "v2" as const,
        opportunities,
        hypotheses: hypotheses.map((h) =>
          h.kind === "proposta"
            ? {
                ...h,
                dossier_md: buildDossier({
                  hypothesis: h,
                  opportunity: oppOf.get(h.opportunity_id ?? "") ?? null,
                  review: h.review,
                  facts,
                  objective: diagnosis.objective_statement,
                }),
              }
            : h,
        ),
      };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_DOSSIER_GET = defineTool({
  name: "PLAN_UX_DOSSIER_GET",
  description:
    "A hypothesis' dossier in markdown: the hypothesis, evidence for and against (with each one's kind), validations by level, the recommended test, the independent review and the conclusion.",
  annotations: { title: "Get Hypothesis Dossier", ...READ },
  inputSchema: z.object({ hypothesis_id: IdSchema }),
  outputSchema: engineOutput(z.object({ markdown: z.string() })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      const h = await store.getHypothesis(org.id, input.hypothesis_id);
      if (!h) return { error: "hipótese não encontrada" };
      const [opportunities, diagnosis] = await Promise.all([
        store.listOpportunities(org.id, h.diagnosis_id),
        store.getDiagnosis(org.id, h.diagnosis_id),
      ]);
      const opportunity =
        opportunities.find((o) => o.id === h.opportunity_id) ?? null;
      return {
        markdown: buildDossier({
          hypothesis: h,
          opportunity,
          review: h.review,
          facts: diagnosis?.evidence ? factBook(diagnosis.evidence) : undefined,
          objective: diagnosis?.objective_statement,
        }),
      };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_DIAGNOSIS_LIST = defineTool({
  name: "PLAN_UX_DIAGNOSIS_LIST",
  description: "The store's diagnoses, newest first, without their evidence.",
  annotations: { title: "List Store Diagnoses", ...READ },
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional(),
  }),
  outputSchema: engineOutput(z.object({ diagnoses: z.array(Row) })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      await store.reapStaleDiagnoses(org.id);
      return {
        diagnoses: await store.listDiagnoses(org.id, input.limit ?? 20),
      };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_SITE_RUN_GET = defineTool({
  name: "PLAN_UX_SITE_RUN_GET",
  description:
    "One run of the store diagnosis: its diagnoses (one per page) and every page's opportunities in one list, most valuable first. An opportunity a page points at on another page analysed in the same run stays with that page's analysis.",
  annotations: { title: "Get Diagnosis Run", ...READ },
  inputSchema: z.object({ site_run_id: IdSchema }),
  outputSchema: engineOutput(
    z.object({
      site_run_id: z.string(),
      diagnoses: z.array(Row),
      opportunities: z.array(Row),
      hidden_elsewhere: z.number(),
    }),
  ),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      await store.reapStaleDiagnoses(org.id);
      const diagnoses = await store.listDiagnoses(
        org.id,
        20,
        input.site_run_id,
      );
      if (diagnoses.length === 0) {
        return { error: "rodada do site não encontrada" };
      }
      const pages = new Set(diagnoses.map((d) => d.page_type));
      let hidden = 0;
      const lists = await Promise.all(
        diagnoses.map(async (d) =>
          (await store.listOpportunities(org.id, d.id))
            .filter((o) => !o.outcome?.retired)
            .filter((o) => {
              if (!coveredElsewhere(o.area, pages)) return true;
              hidden++;
              return false;
            })
            .map((o) => ({ ...o, page_type: d.page_type })),
        ),
      );
      return {
        site_run_id: input.site_run_id,
        diagnoses,
        opportunities: lists.flat().sort(byValue),
        hidden_elsewhere: hidden,
      };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_SITE_RUN_LIST = defineTool({
  name: "PLAN_UX_SITE_RUN_LIST",
  description:
    "The store diagnosis runs, newest first: the goal each started with, its state and its pages. `goal_id` keeps only that goal's runs.",
  annotations: { title: "List Diagnosis Runs", ...READ },
  inputSchema: z.object({
    goal_id: GoalIdSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  outputSchema: engineOutput(z.object({ runs: z.array(SiteRunSchema) })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      await store.reapStaleDiagnoses(org.id);
      return {
        runs: await store.listSiteRuns(org.id, {
          goalId: input.goal_id ?? null,
          limit: Math.min(20, Math.max(1, input.limit ?? 20)),
        }),
      } satisfies ListUxSiteRunsOutput;
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_STORE_VIEW = defineTool({
  name: "PLAN_UX_STORE_VIEW",
  description:
    "The store at a glance: each page's latest analysis (state, funnel by device, screenshot, gaps), the two losses worth most and the rest, the sources with data, and what setup the store still needs. `goal_id` keeps only that goal's runs.",
  annotations: { title: "Get Store View", ...READ },
  inputSchema: z.object({ goal_id: GoalIdSchema.optional() }),
  outputSchema: engineOutput(
    z.object({
      pages: z.array(Row),
      top: z.array(Row),
      others: z.array(Row),
      sources: z.array(z.string()),
      running: z.boolean(),
      setup: Row.optional(),
    }),
  ),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    const goalId = input.goal_id ?? null;
    try {
      await store.reapStaleDiagnoses(org.id);
      // Chosen from the light list; only the chosen come with evidence.
      const chosen = choosePageDiagnoses(
        await store.listDiagnosesForGoal(org.id, goalId),
        goalId,
      );
      const ids = new Set<string>();
      const withResults: string[] = [];
      for (const c of chosen.values()) {
        ids.add(c.latest.id);
        if (c.results) {
          ids.add(c.results.id);
          withResults.push(c.results.id);
        }
      }
      const [diagnoses, opportunities, hypotheses, profile] = await Promise.all(
        [
          Promise.all([...ids].map((id) => store.getDiagnosis(org.id, id))),
          Promise.all(
            withResults.map((id) => store.listOpportunities(org.id, id)),
          ),
          Promise.all(
            withResults.map((id) => store.listHypotheses(org.id, id)),
          ),
          store.getSiteProfile(org.id),
        ],
      );
      return buildStoreView({
        diagnoses: diagnoses.filter((d): d is UxDiagnosis => d !== null),
        opportunities: opportunities.flat(),
        hypotheses: hypotheses.flat(),
        goalId,
        profile,
      });
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_OPPORTUNITY_GET = defineTool({
  name: "PLAN_UX_OPPORTUNITY_GET",
  description:
    "One opportunity (a measured loss) with all its hypotheses: what verification saw, the proposed A/B test, the independent review, the relevance and the knowledge sources cited.",
  annotations: { title: "Get Opportunity", ...READ },
  inputSchema: z.object({ opportunity_id: IdSchema }),
  outputSchema: engineOutput(z.object({ opportunity: Row })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      const o = await store.getOpportunity(org.id, input.opportunity_id);
      if (!o) return { error: "oportunidade não encontrada" };
      const [hypotheses, known] = await Promise.all([
        store.listHypotheses(org.id, o.diagnosis_id),
        ctx.storage.planEngineKnowledge.listKnowledge(org.id),
      ]);
      // Curated and the store's: the engine saves the ids the model cited.
      const byId = new Map(
        [...CURATED_KNOWLEDGE, ...known].map((e) => [e.id, e]),
      );
      const detail = hypotheses
        .filter((h) => h.kind === "proposta" && h.opportunity_id === o.id)
        .sort((a, b) => a.rank - b.rank)
        .map((h) => ({
          ...h,
          lifecycle: lifecycleOf(h),
          experiment: h.experiment ?? null,
          review: h.review ?? null,
          relevance: h.relevance ?? null,
          citations: [...new Set(h.tree?.fontes_conhecimento ?? [])].flatMap(
            (id) => {
              const e = byId.get(id);
              return e ? [citationOf(e)] : [];
            },
          ),
        }));
      return {
        opportunity: { ...o, hypotheses: detail },
      } satisfies GetUxOpportunityOutput;
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

/** Approving or dismissing teaches the store; back to pending turns it off. */
async function learnFromDecision(
  ctx: StudioContext,
  orgId: string,
  h: UxHypothesis,
): Promise<void> {
  try {
    const area = h.opportunity_id
      ? ((
          await ctx.storage.planEngine.listOpportunities(orgId, h.diagnosis_id)
        ).find((o) => o.id === h.opportunity_id)?.area ?? "pagina_geral")
      : "pagina_geral";
    const draft = fromDecision({
      hypothesis: h,
      area,
      status: h.status,
      note: h.status_note,
      at: h.updated_at,
    });
    if (draft) {
      await ctx.storage.planEngineKnowledge.upsertKnowledge(orgId, draft);
    } else {
      await ctx.storage.planEngineKnowledge.setKnowledgeActive(
        orgId,
        learnedId("decisao", h.id),
        false,
      );
    }
  } catch (err) {
    console.warn(
      `[plan-engine] decision on ${h.id} did not become knowledge: ${errorOf(err)}`,
    );
  }
}

export const PLAN_UX_HYPOTHESIS_STATUS_UPDATE = defineTool({
  name: "PLAN_UX_HYPOTHESIS_STATUS_UPDATE",
  description:
    "Approve, dismiss or return to pending a store diagnosis hypothesis. Only a hypothesis ready for a test can be approved. The decision becomes the store's knowledge.",
  annotations: { title: "Decide Hypothesis", ...WRITE },
  inputSchema: z.object({
    hypothesis_id: IdSchema,
    status: z.enum(["pending", "approved", "dismissed"]),
    note: z.string().max(2000).optional(),
  }),
  outputSchema: engineOutput(z.object({ hypothesis: Row })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      if (input.status === "approved") {
        const current = await store.getHypothesis(org.id, input.hypothesis_id);
        if (!current) return { error: "hipótese não encontrada" };
        const state = lifecycleOf(current);
        // Approved before the lock stays as it is; approving again, not.
        if (current.status !== "approved" && !canApprove(state)) {
          return {
            error: `Só dá pra aprovar pra teste a hipótese pronta: condição confirmada, relevante e com teste que fecha em até 8 semanas (hoje: ${LIFECYCLE_WORD[state]}).`,
          };
        }
      }
      const hypothesis = await store.setHypothesisStatus(
        org.id,
        input.hypothesis_id,
        input.status,
        input.note?.trim() || null,
      );
      if (!hypothesis) return { error: "hipótese não encontrada" };
      await learnFromDecision(ctx, org.id, hypothesis);
      return { hypothesis } satisfies UpdateUxHypothesisStatusOutput;
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

type QueueItem = UxHypothesis & {
  diagnosis_started_at: string;
  opportunity_title: string | null;
};

export const PLAN_UX_QUEUE_LIST = defineTool({
  name: "PLAN_UX_QUEUE_LIST",
  description:
    "Hypotheses approved for testing, from every diagnosis, by test priority (an opportunity's monthly value counts once).",
  annotations: { title: "List Approved Hypotheses", ...READ },
  inputSchema: z.object({}),
  outputSchema: engineOutput(z.object({ hypotheses: z.array(Row) })),
  handler: async (_input, ctx) => {
    const org = await engineOrg(ctx);
    const store = ctx.storage.planEngine;
    try {
      const diagnoses = await store.listDiagnoses(org.id, 50);
      const out: QueueItem[] = [];
      for (const d of diagnoses.filter((x) => x.hypotheses_approved > 0)) {
        const opportunities = new Map(
          (await store.listOpportunities(org.id, d.id)).map((o) => [o.id, o]),
        );
        for (const h of await store.listHypotheses(org.id, d.id)) {
          if (h.status === "approved" && h.kind === "proposta") {
            const o = h.opportunity_id
              ? opportunities.get(h.opportunity_id)
              : undefined;
            // In v2 the value lives on the opportunity.
            out.push({
              ...h,
              money: h.money ?? o?.money ?? null,
              diagnosis_started_at: d.started_at,
              opportunity_title: o?.title ?? null,
            });
          }
        }
      }
      return { hypotheses: queueOrder(out) };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});
