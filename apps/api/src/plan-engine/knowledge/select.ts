/**
 * Which knowledge entries go into the prompt: what applies to the page part,
 * this store first, weighted by source type × reliability × age. Each entry
 * gets a [K1], [K2]… label the model cites; labels not in the block are
 * dropped on parse (`resolveCitations`).
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
  /** Prompt text; empty = nothing to say. */
  text: string;
  /** "K3" → entry. */
  byLabel: Map<string, KnowledgeEntry>;
}

const DAY_MS = 86_400_000;
const STORE_ORIGINS = new Set(["manual", "veredito", "decisao"]);

const isStoreEntry = (e: KnowledgeEntry) => STORE_ORIGINS.has(e.origem);

export function knowledgeScore(e: KnowledgeEntry, now = Date.now()): number {
  const age = (now - Date.parse(e.updated_at)) / DAY_MS;
  const recency = isStoreEntry(e) && Number.isFinite(age) && age > 90 ? 0.7 : 1;
  // Verdict from a page that has since changed: history, low weight
  const validity = e.stale ? 0.3 : 1;
  return (
    SOURCE_WEIGHT[e.tipo_fonte] *
    RELIABILITY_WEIGHT[e.confiabilidade] *
    recency *
    validity
  );
}

/** One short line per entry, with what matters for weighing. */
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
  /** Page parts in play. Empty = all. */
  areas: UxArea[];
  /** The analyzed page type: "the whole page" (`pagina_geral`) pulls in its parts. Absent = PDP. */
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
  // Match a part in play directly, not only via the `pagina_geral` wildcard, which alone pulls in unrelated studies
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
  // What the STORE learned always enters, from any page part: few entries, the most relevant ones; the part only orders
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

/** One of each category first, then the rest by score. */
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

/** The prompt section, with the rule for weighing. Empty without entries. */
export function knowledgeForPrompt(block: KnowledgeBlock): string {
  if (!block.text) return "";
  return `## O que já se sabe (base de conhecimento)
Pese pelo tipo: A/B desta loja > verificado nesta loja > estudo > A/B de outra loja > benchmark e boa prática > opinião. Benchmark é sinal de mercado, não prova. "Verificado nesta loja (confirmada)" quer dizer que a CONDIÇÃO existe na página, não que ela causa perda. Se um A/B desta loja já testou algo parecido, diga e não repita sem um mecanismo novo. Cite pelo rótulo ([K1]) só o que usar.
${block.text}`;
}

/** Labels cited by the model → only those that were in the block, without repeats. */
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
