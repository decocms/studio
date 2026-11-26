/**
 * What the store knows, for the Plan engine: A/B tests already run, the
 * verifier's verdicts and the team's decisions, next to the curated general
 * knowledge.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { asArea } from "@/plan-engine/areas";
import { CURATED_KNOWLEDGE } from "@/plan-engine/knowledge/curated";
import { articleFor, PUBLISHERS } from "@/plan-engine/knowledge/sources";
import { NEEDS_URL } from "@/plan-engine/knowledge/types";
import { engineOrg, engineOutput, errorOf, READ, Row, WRITE } from "./gate";

const KNOWLEDGE_DRAFT = z.object({
  conhecimento: z.string().min(5).max(400),
  categoria: z.enum([
    "ux",
    "performance",
    "confianca",
    "comercial",
    "trafego",
    "tecnologia",
  ]),
  fonte: z.string().min(2).max(200),
  fonte_url: z.string().url().nullable().optional(),
  tipo_fonte: z.enum([
    "ab_desta_loja",
    "estudo",
    "ab_outra_loja",
    "benchmark",
    "boa_pratica",
    "opiniao",
  ]),
  contexto: z.string().max(300).optional(),
  areas: z.array(z.string()).max(12).optional(),
  evidencia: z.string().max(600).optional(),
  /** The literal excerpt of the source holding the number. */
  trecho: z.string().max(600).nullable().optional(),
  confiabilidade: z.enum(["alta", "media", "baixa"]).optional(),
  limitacoes: z.string().max(400).optional(),
  resultado: z.enum(["positivo", "negativo", "neutro"]).nullable().optional(),
});

export const PLAN_UX_KNOWLEDGE_LIST = defineTool({
  name: "PLAN_UX_KNOWLEDGE_LIST",
  description:
    "The store diagnosis knowledge base: what the store already knows (A/B tests, the verifier's verdicts, the team's decisions) and the curated general knowledge.",
  annotations: { title: "List Store Knowledge", ...READ },
  inputSchema: z.object({}),
  outputSchema: engineOutput(
    z.object({
      store: z.array(Row),
      curated: z.array(Row),
      publishers: z.array(Row),
    }),
  ),
  handler: async (_input, ctx) => {
    const org = await engineOrg(ctx);
    try {
      return {
        store: await ctx.storage.planEngineKnowledge.listKnowledge(org.id),
        curated: CURATED_KNOWLEDGE.map((e) => ({
          ...e,
          artigo: articleFor(e.fonte_url),
        })),
        publishers: PUBLISHERS,
      };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_KNOWLEDGE_UPSERT = defineTool({
  name: "PLAN_UX_KNOWLEDGE_UPSERT",
  description:
    "Add or edit (with `id`) an entry of the store's knowledge base, such as an A/B test already run. 'estudo' and 'ab_outra_loja' need an https fonte_url. Only manual entries are edited here.",
  annotations: { title: "Save Store Knowledge", ...WRITE },
  inputSchema: z.object({
    id: z.string().max(128).optional(),
    entry: KNOWLEDGE_DRAFT,
  }),
  outputSchema: engineOutput(z.object({ entry: Row })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    const knowledge = ctx.storage.planEngineKnowledge;
    const e = input.entry;
    const url = e.fonte_url?.trim() || null;
    if (NEEDS_URL.includes(e.tipo_fonte) && !url?.startsWith("https://")) {
      return {
        error: `"${e.tipo_fonte}" precisa de fonte_url https (o link pra fonte).`,
      };
    }
    if (input.id && !/^[A-Za-z0-9-]+$/.test(input.id)) {
      return {
        error:
          "só entradas manuais se editam aqui (as aprendidas mudam sozinhas)",
      };
    }
    try {
      // An id this org does not have creates nothing, as for another org's.
      if (input.id && !(await knowledge.getKnowledge(org.id, input.id))) {
        return { error: "entrada não encontrada" };
      }
      const entry = await knowledge.upsertKnowledge(org.id, {
        id: input.id,
        conhecimento: e.conhecimento.trim(),
        categoria: e.categoria,
        fonte: e.fonte.trim(),
        fonte_url: url,
        tipo_fonte: e.tipo_fonte,
        contexto: e.contexto?.trim() ?? "",
        areas: (e.areas ?? []).map(asArea),
        evidencia: e.evidencia?.trim() ?? "",
        trecho: e.trecho?.trim() || null,
        confiabilidade: e.confiabilidade ?? "media",
        limitacoes: e.limitacoes?.trim() ?? "",
        resultado: e.resultado ?? null,
        origem: "manual",
        diagnosis_id: null,
        hypothesis_id: null,
        active: true,
      });
      return { entry };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_KNOWLEDGE_ACTIVE_SET = defineTool({
  name: "PLAN_UX_KNOWLEDGE_ACTIVE_SET",
  description:
    "Turn an entry of the store's knowledge base on or off. An entry turned off stays listed and stays out of the next analyses.",
  annotations: { title: "Toggle Store Knowledge", ...WRITE },
  inputSchema: z.object({
    id: z.string().min(1).max(256),
    active: z.boolean(),
  }),
  outputSchema: engineOutput(z.object({ entry: Row })),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    try {
      const entry = await ctx.storage.planEngineKnowledge.setKnowledgeActive(
        org.id,
        input.id,
        input.active,
      );
      if (!entry) return { error: "entrada não encontrada" };
      return { entry };
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});
