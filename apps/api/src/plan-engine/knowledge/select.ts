/**
 * Quais entradas da base vão pro prompt, e como.
 *
 * O prompt não aguenta a base inteira, e nem deve: entra o que vale pra parte
 * da página em questão, a loja primeiro (um A/B desta loja vale mais que
 * qualquer estudo), pesado pelo tipo de fonte × confiabilidade × idade. Cada
 * entrada ganha um rótulo [K1], [K2]… que o modelo cita; rótulo que não estava
 * no bloco é descartado no parse (`resolveCitations`).
 */

import { PAGE_TYPES } from "../page-types.ts";
import type { UxArea, UxPageType } from "../types.ts";
import {
  type KnowledgeEntry,
  RELIABILITY_WEIGHT,
  SOURCE_TYPE_LABEL,
  SOURCE_WEIGHT,
} from "./types.ts";

export interface KnowledgeBlock {
  /** Texto pro prompt; vazio = nada a dizer. */
  text: string;
  /** "K3" → entrada. */
  byLabel: Map<string, KnowledgeEntry>;
}

const DAY_MS = 86_400_000;
const STORE_ORIGINS = new Set(["manual", "veredito", "decisao"]);

const isStoreEntry = (e: KnowledgeEntry) => STORE_ORIGINS.has(e.origem);

export function knowledgeScore(e: KnowledgeEntry, now = Date.now()): number {
  const age = (now - Date.parse(e.updated_at)) / DAY_MS;
  const recency = isStoreEntry(e) && Number.isFinite(age) && age > 90 ? 0.7 : 1;
  // Veredito de uma página que mudou desde então: histórico, peso baixo.
  const validity = e.stale ? 0.3 : 1;
  return (
    SOURCE_WEIGHT[e.tipo_fonte] *
    RELIABILITY_WEIGHT[e.confiabilidade] *
    recency *
    validity
  );
}

/** Uma linha por entrada, curta, com o que importa pra pesar. */
export function knowledgeLine(label: string, e: KnowledgeEntry): string {
  const result = e.resultado ? ` (${e.resultado})` : "";
  const parts = [
    `[${label}] ${e.stale ? "VENCIDO — a página mudou desde esse veredito; vale como histórico, não como fato de hoje. " : ""}${SOURCE_TYPE_LABEL[e.tipo_fonte]}${result}, confiabilidade ${e.confiabilidade}: ${e.conhecimento}`,
    e.evidencia ? `Achado: ${e.evidencia}` : "",
    e.limitacoes ? `Limite: ${e.limitacoes}` : "",
    `Fonte: ${e.fonte}`,
  ].filter(Boolean);
  const line = parts.join(" ");
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

const MAX_LINE = 360;

export function selectKnowledge(opts: {
  entries: KnowledgeEntry[];
  /** Partes da página em jogo. Vazio = todas. */
  areas: UxArea[];
  /**
   * O tipo de página analisado: "a página inteira" (`pagina_geral`) puxa as
   * partes dela. Ausente = PDP.
   */
  pageType?: UxPageType;
  maxStore?: number;
  maxCurated?: number;
  maxChars?: number;
  now?: number;
}): KnowledgeBlock {
  const maxStore = opts.maxStore ?? 6;
  const maxCurated = opts.maxCurated ?? 6;
  const maxChars = opts.maxChars ?? 3_000;
  const areas = new Set(opts.areas);
  if (areas.has("pagina_geral")) {
    for (const a of PAGE_TYPES[opts.pageType ?? "pdp"].areas) areas.add(a);
  }
  // Bate direto numa parte em jogo (não só pelo coringa `pagina_geral`): com
  // a base do site inteiro (16/11) o coringa sozinho trazia estudo de
  // checkout pra hipótese de filtro.
  const direct = (e: KnowledgeEntry) => e.areas.some((a) => areas.has(a));
  const fits = (e: KnowledgeEntry) =>
    e.active &&
    (areas.size === 0 ||
      e.areas.length === 0 ||
      e.areas.some((a) => areas.has(a) || a === "pagina_geral"));
  const ranked = (list: KnowledgeEntry[]) =>
    [...list].sort(
      (a, b) => knowledgeScore(b, opts.now) - knowledgeScore(a, opts.now),
    );
  const candidates = opts.entries.filter(fits);
  // O que a LOJA aprendeu entra sempre, de qualquer parte da página: são
  // poucas entradas e as que mais importam. Em 16/11 (numa loja de moda) "o Leve
  // o Look toma a primeira tela" voltou desmentido de novo porque o veredito
  // era de "leve_o_look" e a oportunidade, de "tamanho". A parte só ordena.
  const storeAll = opts.entries.filter((e) => e.active && isStoreEntry(e));
  const store = [
    ...ranked(storeAll.filter(fits)),
    ...ranked(storeAll.filter((e) => !fits(e))),
  ].slice(0, maxStore);
  const general = candidates.filter((e) => !isStoreEntry(e));
  const curated = diversify(
    [
      ...ranked(general.filter(direct)),
      ...ranked(general.filter((e) => !direct(e))),
    ],
    maxCurated,
  );

  const byLabel = new Map<string, KnowledgeEntry>();
  const lines: string[] = [];
  let used = 0;
  for (const e of [...store, ...curated]) {
    const label = `K${byLabel.size + 1}`;
    const line = knowledgeLine(label, e);
    if (used + line.length > maxChars) break;
    used += line.length;
    byLabel.set(label, e);
    lines.push(`- ${line}`);
  }
  return { text: lines.join("\n"), byLabel };
}

/** Uma de cada categoria primeiro, depois o resto pela nota. */
function diversify(list: KnowledgeEntry[], max: number): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (out.length >= max) break;
    if (!seen.has(e.categoria)) {
      seen.add(e.categoria);
      out.push(e);
    }
  }
  for (const e of list) {
    if (out.length >= max) break;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** A seção do prompt, com a regra de como pesar. Vazio sem entradas. */
export function knowledgeForPrompt(block: KnowledgeBlock): string {
  if (!block.text) return "";
  return `## O que já se sabe (base de conhecimento)
Pese pelo tipo: A/B desta loja > verificado nesta loja > estudo > A/B de outra loja > benchmark e boa prática > opinião. Benchmark é sinal de mercado, não prova. "Verificado nesta loja (confirmada)" quer dizer que a CONDIÇÃO existe na página, não que ela causa perda. Se um A/B desta loja já testou algo parecido, diga e não repita sem um mecanismo novo. Cite pelo rótulo ([K1]) só o que usar.
${block.text}`;
}

/** Rótulos citados pelo modelo → só os que estavam no bloco, sem repetir. */
export function resolveCitations(
  raw: unknown,
  block: KnowledgeBlock,
): KnowledgeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeEntry[] = [];
  for (const item of raw) {
    const label = String(item ?? "")
      .trim()
      .replace(/^\[|\]$/g, "")
      .toUpperCase();
    const e = block.byLabel.get(label);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}
