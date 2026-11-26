/**
 * What a store knows (migration 272), for the store-analysis engine. The
 * general knowledge is not here: it is code (`plan-engine/knowledge/curated.ts`).
 */

import { type Kysely, sql } from "kysely";
import type { KnowledgeDraft } from "../plan-engine/knowledge/learn.ts";
import type {
  KnowledgeEntry,
  KnowledgeResult,
} from "../plan-engine/knowledge/types.ts";
import type { UxArea } from "../plan-engine/types.ts";
import { fromJson, jsonb, nowIso, str, strOrNull, ts } from "./plan-engine.ts";
import type { Database } from "./types";

function rowToKnowledge(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: str(row.id),
    conhecimento: str(row.conhecimento),
    categoria: str(row.categoria) as KnowledgeEntry["categoria"],
    fonte: str(row.fonte),
    fonte_url: strOrNull(row.fonte_url),
    tipo_fonte: str(row.tipo_fonte) as KnowledgeEntry["tipo_fonte"],
    contexto: str(row.contexto),
    areas: fromJson<UxArea[]>(row.areas, []),
    evidencia: str(row.evidencia),
    trecho: strOrNull(row.trecho),
    assinatura: strOrNull(row.assinatura),
    confiabilidade: str(row.confiabilidade) as KnowledgeEntry["confiabilidade"],
    limitacoes: str(row.limitacoes),
    resultado:
      row.resultado == null ? null : (str(row.resultado) as KnowledgeResult),
    origem: str(row.origem) as KnowledgeEntry["origem"],
    diagnosis_id: strOrNull(row.diagnosis_id),
    hypothesis_id: strOrNull(row.hypothesis_id),
    active: row.active !== false,
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}

export class PlanEngineKnowledgeStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async listKnowledge(
    orgId: string,
    opts: { activeOnly?: boolean } = {},
  ): Promise<KnowledgeEntry[]> {
    const { rows } = await sql<Record<string, unknown>>`
      SELECT * FROM plan_ux_knowledge
       WHERE organization_id = ${orgId}
         ${opts.activeOnly ? sql`AND active` : sql``}
       ORDER BY updated_at DESC
       LIMIT 500
    `.execute(this.db);
    return rows.map(rowToKnowledge);
  }

  /** One of this org's entries, or null (missing or another org's). */
  async getKnowledge(
    orgId: string,
    id: string,
  ): Promise<KnowledgeEntry | null> {
    const { rows } = await sql<Record<string, unknown>>`
      SELECT * FROM plan_ux_knowledge
       WHERE id = ${id} AND organization_id = ${orgId}
    `.execute(this.db);
    return rows[0] ? rowToKnowledge(rows[0]) : null;
  }

  /**
   * Writes (or replaces, by id) an entry; without an id it is manual and gets
   * one. `created_at` stays the first write's. An id another org holds is not
   * overwritten: the write fails.
   */
  async upsertKnowledge(
    orgId: string,
    draft: Omit<KnowledgeDraft, "id"> & { id?: string },
  ): Promise<KnowledgeEntry> {
    const id = draft.id ?? crypto.randomUUID();
    const now = nowIso();
    const { rows } = await sql<Record<string, unknown>>`
      INSERT INTO plan_ux_knowledge
        (id, conhecimento, categoria, fonte, fonte_url, tipo_fonte, contexto,
         areas, evidencia, confiabilidade, limitacoes, resultado, origem,
         diagnosis_id, hypothesis_id, active, created_at, updated_at, trecho,
         assinatura, organization_id)
      VALUES (${id}, ${draft.conhecimento}, ${draft.categoria}, ${draft.fonte},
              ${draft.fonte_url}, ${draft.tipo_fonte}, ${draft.contexto},
              ${jsonb(draft.areas ?? [])}, ${draft.evidencia},
              ${draft.confiabilidade}, ${draft.limitacoes}, ${draft.resultado},
              ${draft.origem}, ${draft.diagnosis_id}, ${draft.hypothesis_id},
              ${draft.active}, ${ts(now)}, ${ts(now)}, ${draft.trecho ?? null},
              ${draft.assinatura ?? null}, ${orgId})
      ON CONFLICT (id) DO UPDATE SET
        conhecimento = excluded.conhecimento,
        categoria = excluded.categoria,
        fonte = excluded.fonte,
        fonte_url = excluded.fonte_url,
        tipo_fonte = excluded.tipo_fonte,
        contexto = excluded.contexto,
        areas = excluded.areas,
        evidencia = excluded.evidencia,
        confiabilidade = excluded.confiabilidade,
        limitacoes = excluded.limitacoes,
        resultado = excluded.resultado,
        origem = excluded.origem,
        diagnosis_id = excluded.diagnosis_id,
        hypothesis_id = excluded.hypothesis_id,
        active = excluded.active,
        updated_at = excluded.updated_at,
        trecho = excluded.trecho,
        assinatura = excluded.assinatura
      WHERE plan_ux_knowledge.organization_id = excluded.organization_id
      RETURNING *
    `.execute(this.db);
    if (!rows[0]) throw new Error(`conhecimento ${id} não gravou`);
    return rowToKnowledge(rows[0]);
  }

  /** Turns an entry on or off: off leaves the prompt and stays on screen. */
  async setKnowledgeActive(
    orgId: string,
    id: string,
    active: boolean,
  ): Promise<KnowledgeEntry | null> {
    const { rows } = await sql<Record<string, unknown>>`
      UPDATE plan_ux_knowledge
         SET active = ${active}, updated_at = ${ts(nowIso())}
       WHERE id = ${id} AND organization_id = ${orgId}
      RETURNING *
    `.execute(this.db);
    return rows[0] ? rowToKnowledge(rows[0]) : null;
  }

  /**
   * What goes in the prompt: the store's active entries and the curated
   * ones. A failed read does not stop the run: only the curated, and why.
   */
  async knowledgeForRun(
    orgId: string,
    curated: KnowledgeEntry[],
  ): Promise<{ entries: KnowledgeEntry[]; error: string | null }> {
    try {
      return {
        entries: [
          ...(await this.listKnowledge(orgId, { activeOnly: true })),
          ...curated,
        ],
        error: null,
      };
    } catch (err) {
      return {
        entries: curated,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
