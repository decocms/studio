/**
 * The hypothesis tree: for each opportunity, COMPETING explanations in six
 * categories (UX, performance, trust, commercial, traffic, technology), each
 * with support, contradiction, how to verify and how to refute. The model
 * writes the parts; the "If..., then..., because..." sentence and labels are
 * built and checked here.
 */

import {
  CLAIM_WORD,
  clampLabel,
  groundedLabel,
  type UxClaimLabel,
} from "./claims.ts";
import {
  checkGrounding,
  factLine,
  parseFactIds,
  type UxFact,
} from "./facts.ts";
import type { KnowledgeCategory } from "./knowledge/types.ts";
import { isMetricKey, type UxMetricKey } from "./metrics.ts";
import { MAX_DELTA_PP } from "./money.ts";
import { PART_WORD, pageSpec } from "./page-types.ts";
import type { DiagnosisEvidence, UxPart } from "./types.ts";

export type HypothesisCategory = KnowledgeCategory;

const CATEGORIES: HypothesisCategory[] = [
  "ux",
  "performance",
  "confianca",
  "comercial",
  "trafego",
  "tecnologia",
];

export const CATEGORY_WORD: Record<HypothesisCategory, string> = {
  ux: "UX e interface",
  performance: "Performance",
  confianca: "Confiança",
  comercial: "Comercial",
  trafego: "Tráfego",
  tecnologia: "Tecnologia",
};

/** Categories whose cause may not be on the page; in the others a hypothesis without an intervention is dropped. */
const MAY_HAVE_NO_INTERVENTION: HypothesisCategory[] = ["trafego", "comercial"];

export interface UxClaim {
  text: string;
  label: UxClaimLabel;
  /** The cited facts that exist (F12...). Absent = older data. */
  facts?: string[];
}

export interface HypothesisTarget {
  kind: "part" | "element" | "section";
  key: string;
  /** What it is, in words ("buy button", `button "comprar"`). */
  label: string;
}

export type RelationKind = "causa_comum" | "concorrente" | "complementar";

export interface HypothesisTree {
  category: HypothesisCategory;
  /** "If ..., then ..., because ...". NULL = explanation with no page change. */
  statement: string | null;
  intervencao: string | null;
  resultado: string;
  mecanismo: string;
  /** The suspected cause, in one sentence (becomes the title). */
  causa: string;
  a_favor: UxClaim[];
  contra: UxClaim[];
  /** Ids of the cited knowledge-base entries. */
  fontes_conhecimento: string[];
  segmento: string;
  metrica: {
    key: UxMetricKey | null;
    direcao: "sobe" | "desce";
    /** Expected effect in pp, capped by money.ts. NULL = not stated. */
    efeito_esperado_pp: number | null;
  };
  como_verificar: string;
  como_refutar: string;
  /** Where on the page. NULL = does not point to a part (or was not validated). */
  alvo: HypothesisTarget | null;
  /** After the change, does the target end up on the first screen? (relevance, PR F) */
  posicao_depois: "mesma" | "primeira_tela";
  /** Links to other hypotheses of the SAME opportunity, by rank. */
  relacoes: Array<{ rank: number; tipo: RelationKind }>;
  esforco: 1 | 2 | 3;
  /** Has something to change/check on the page (goes to the verifier and the mockup). */
  testavel_na_pagina: boolean;
  /** Segment opportunity: why the cause weighs more on it. */
  por_que_no_segmento?: string;
  /** Device loss: what the cause has that differs between screens. */
  por_que_no_dispositivo?: string;
  /** Device loss: the facts showing the difference, at least one per screen (facts.ts). Absent = older data. */
  fatos_contraste?: string[];
}

/** A category that did not become a hypothesis, and why (the whole tree on screen). */
export interface DiscardedCategory {
  category: HypothesisCategory;
  why: string;
}

const text = (v: unknown) => (v == null ? "" : String(v).trim());

const normalize = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^ux.*/, "ux")
    .trim();

const asCategory = (v: unknown): HypothesisCategory | null => {
  const t = text(v).toLowerCase();
  return CATEGORIES.find((c) => c === t) ?? null;
};

/** The parts, elements and sections that exist in this analysis. */
export function targetsOf(evidence: DiagnosisEvidence): {
  parts: Set<string>;
  elements: Map<string, string>;
  sections: Set<string>;
} {
  const elements = new Map<string, string>();
  for (const c of evidence.captures) {
    for (const [k, v] of Object.entries(c.element_labels ?? {})) {
      elements.set(k, v.label);
    }
  }
  return {
    // The parts the capture measures on THIS page type.
    parts: new Set(Object.keys(pageSpec(evidence.page_type).parts)),
    elements,
    sections: new Set(
      evidence.pdp_behaviour.flatMap((b) => b.sections.map((s) => s.section)),
    ),
  };
}

function parseTarget(
  raw: unknown,
  targets: ReturnType<typeof targetsOf>,
): HypothesisTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const key = text(t.key);
  if (t.kind === "part" && targets.parts.has(key)) {
    return {
      kind: "part",
      key,
      label: PART_WORD[key as UxPart] ?? key,
    };
  }
  if (t.kind === "element" && targets.elements.has(key)) {
    return { kind: "element", key, label: targets.elements.get(key) ?? key };
  }
  if (t.kind === "section" && targets.sections.has(key)) {
    return { kind: "section", key, label: `seção ${key}` };
  }
  return null;
}

/** The model's for / against -> labeled claims, with labels checked against the cited facts (digit rule without a ledger). */
export function parseClaims(
  raw: unknown,
  book?: Map<string, UxFact>,
): UxClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: UxClaim[] = [];
  for (const item of raw.slice(0, 6)) {
    const r = (item ?? {}) as Record<string, unknown>;
    const t = typeof item === "string" ? item.trim() : text(r.texto ?? r.text);
    if (!t) continue;
    const asked = r.tipo ?? r.label;
    if (!book) {
      out.push({ text: t, label: clampLabel(asked, t) });
      continue;
    }
    const g = checkGrounding(t, parseFactIds(r.fatos ?? r.facts), book);
    out.push({
      text: t,
      label: groundedLabel(asked, g),
      facts: g.facts.map((f) => f.id),
    });
  }
  return out;
}

const RELATIONS: RelationKind[] = [
  "causa_comum",
  "concorrente",
  "complementar",
];

/** A raw model hypothesis -> tree, or the reason it does not get in. */
export function parseTree(
  raw: Record<string, unknown>,
  targets: ReturnType<typeof targetsOf>,
  ownRank: number,
  book?: Map<string, UxFact>,
): HypothesisTree | string {
  const category = asCategory(raw.categoria ?? raw.category) ?? "ux";
  const causa = text(raw.causa ?? raw.title);
  const intervencao = text(raw.intervencao ?? raw.idea) || null;
  const resultado = text(raw.resultado);
  const mecanismo = text(raw.mecanismo ?? raw.why);
  if (!causa) return "sem causa";
  if (!mecanismo)
    return `"${causa}" (sem mecanismo: por que isso causaria a perda?)`;
  if (!intervencao && !MAY_HAVE_NO_INTERVENTION.includes(category)) {
    return `"${causa}" (sem intervenção na página)`;
  }
  const m = (raw.metrica ?? {}) as Record<string, unknown>;
  const effect = Number(m.efeito_esperado_pp);
  const statement = intervencao
    ? `Se ${lower(intervencao)}, então ${lower(resultado || "a métrica da oportunidade melhora")}, porque ${lower(mecanismo)}.`.replace(
        /\.\.$/,
        ".",
      )
    : null;
  const esforco = Number(raw.esforco);
  return {
    category,
    statement,
    intervencao,
    resultado,
    mecanismo,
    causa,
    a_favor: parseClaims(raw.a_favor, book),
    contra: parseClaims(raw.contra, book),
    fontes_conhecimento: [],
    segmento: text(raw.segmento),
    metrica: {
      key: isMetricKey(m.key) ? m.key : null,
      direcao: text(m.direcao) === "desce" ? "desce" : "sobe",
      efeito_esperado_pp: Number.isFinite(effect)
        ? Math.min(MAX_DELTA_PP, Math.max(0.3, effect))
        : null,
    },
    como_verificar: text(raw.como_verificar),
    como_refutar: text(raw.como_refutar),
    alvo: parseTarget(raw.alvo, targets),
    posicao_depois:
      text(raw.posicao_depois) === "primeira_tela" ? "primeira_tela" : "mesma",
    relacoes: (Array.isArray(raw.relacoes) ? raw.relacoes : [])
      .map((r) => (r ?? {}) as Record<string, unknown>)
      .map((r) => ({
        rank: Number(r.rank),
        tipo: RELATIONS.find((k) => k === r.tipo) ?? "concorrente",
      }))
      .filter((r) => Number.isInteger(r.rank) && r.rank !== ownRank),
    esforco: esforco === 1 || esforco === 3 ? esforco : 2,
    testavel_na_pagina: intervencao !== null,
  };
}

export function parseDiscarded(raw: unknown): DiscardedCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscardedCategory[] = [];
  for (const item of raw) {
    // Accepts an object ({categoria, por_que}) and text ("performance: LCP ok"); the model returns both shapes.
    const str = typeof item === "string" ? item : null;
    const r = (str ? {} : (item ?? {})) as Record<string, unknown>;
    const category = str
      ? asCategory(normalize(str.split(/[:—-]/)[0]!))
      : asCategory(normalize(text(r.categoria ?? r.category ?? r.nome)));
    const why = str
      ? text(str.split(/[:—-]/).slice(1).join(":"))
      : text(r.por_que ?? r.porque ?? r.motivo ?? r.why ?? r.reason);
    if (category && why && !out.some((d) => d.category === category)) {
      out.push({ category, why });
    }
  }
  return out;
}

/** For / against as short markdown with each label and, under each claim, the cited data. */
export function claimsMarkdown(
  tree: HypothesisTree,
  book?: Map<string, UxFact>,
): string {
  const cited = (c: UxClaim) =>
    book
      ? (c.facts ?? [])
          .map((id) => book.get(id))
          .filter((f): f is UxFact => !!f)
          .map((f) => `\n  - ${factLine(f)}`)
          .join("")
      : "";
  const list = (claims: UxClaim[]) =>
    claims
      .map((c) => `- ${c.text} (${CLAIM_WORD[c.label]})${cited(c)}`)
      .join("\n");
  return [
    tree.a_favor.length > 0 ? `**A favor:**\n${list(tree.a_favor)}` : "",
    tree.contra.length > 0 ? `**Contra:**\n${list(tree.contra)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const lower = (s: string) =>
  s.length > 1 && s[1] === s[1]!.toLowerCase()
    ? s[0]!.toLowerCase() + s.slice(1)
    : s;
