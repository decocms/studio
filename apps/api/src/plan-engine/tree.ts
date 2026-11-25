/**
 * A árvore de hipóteses: pra cada oportunidade, explicações CONCORRENTES em
 * seis categorias (UX, performance, confiança, comercial, tráfego,
 * tecnologia), no formato "Se [intervenção], então [resultado], porque
 * [mecanismo]", cada uma com o que a apoia, o que a contradiz, como verificar
 * e como refutar.
 *
 * Por que árvore: uma explicação só prende a análise nela. Com "o tráfego do
 * celular tem menos intenção" ao lado de "o tamanho fica abaixo da dobra", a
 * tela mostra que existe outra explicação — e que ela não se resolve mexendo
 * na página.
 *
 * O modelo escreve as partes; a frase "Se…, então…, porque…" e os rótulos são
 * montados e conferidos aqui.
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

/**
 * Categorias cuja causa pode não estar na página: "o tráfego do celular tem
 * menos intenção" é uma explicação válida sem nenhuma mudança de UI pra
 * propor. Nas outras, hipótese sem intervenção não entra.
 */
const MAY_HAVE_NO_INTERVENTION: HypothesisCategory[] = ["trafego", "comercial"];

export interface UxClaim {
  text: string;
  label: UxClaimLabel;
  /** Os fatos citados que existem (F12…). Ausente = antes de 19/11. */
  facts?: string[];
}

export interface HypothesisTarget {
  kind: "part" | "element" | "section";
  key: string;
  /** O que é, em palavras ("botão de compra", `button "comprar"`). */
  label: string;
}

export type RelationKind = "causa_comum" | "concorrente" | "complementar";

export interface HypothesisTree {
  category: HypothesisCategory;
  /** "Se …, então …, porque …". NULL = explicação sem mudança na página. */
  statement: string | null;
  intervencao: string | null;
  resultado: string;
  mecanismo: string;
  /** A causa suspeita, numa frase (vira o título). */
  causa: string;
  a_favor: UxClaim[];
  contra: UxClaim[];
  /** Ids das entradas da base de conhecimento citadas. */
  fontes_conhecimento: string[];
  segmento: string;
  metrica: {
    key: UxMetricKey | null;
    direcao: "sobe" | "desce";
    /** Efeito esperado em pp, no teto do money.ts. NULL = não disse. */
    efeito_esperado_pp: number | null;
  };
  como_verificar: string;
  como_refutar: string;
  /** Onde na página. NULL = não aponta uma parte (ou não validou). */
  alvo: HypothesisTarget | null;
  /** Depois da mudança, o alvo fica na primeira tela? (relevância, PR F). */
  posicao_depois: "mesma" | "primeira_tela";
  /** Ligações com outras hipóteses da MESMA oportunidade, por rank. */
  relacoes: Array<{ rank: number; tipo: RelationKind }>;
  esforco: 1 | 2 | 3;
  /** Tem algo a mudar/conferir na página (vai pro verificador e pro mockup). */
  testavel_na_pagina: boolean;
  /** Oportunidade de um segmento: por que a causa pesa mais nele. */
  por_que_no_segmento?: string;
  /** Perda de dispositivo: o que a causa tem de diferente entre as telas. */
  por_que_no_dispositivo?: string;
  /**
   * Perda de dispositivo: os fatos que mostram a diferença, ao menos um de
   * cada tela (facts.ts). Ausente = antes de 19/11.
   */
  fatos_contraste?: string[];
}

/** Uma categoria que não virou hipótese, e por quê (a árvore inteira na tela). */
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

/** As partes, elementos e seções que existem nesta análise. */
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
    // As partes que a captura mede NESTE tipo de página.
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

/**
 * A favor / contra do modelo → afirmações rotuladas. Com o livro de fatos, o
 * rótulo é conferido contra os fatos citados (groundedLabel); sem ele (teste,
 * evidência antiga), vale a regra antiga do dígito.
 */
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

/** Uma hipótese crua do modelo → árvore, ou o motivo de não entrar. */
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
    // Aceita objeto ({categoria, por_que}) e texto ("performance: LCP ok"):
    // em 15/11 a primeira rodada real voltou sem nenhuma descartada.
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

/**
 * A favor / contra em markdown curto, com o rótulo de cada um. Com o livro de
 * fatos, cada afirmação traz embaixo os dados que ela cita (fonte, tela e a
 * frase medida): quem lê confere sem abrir nada.
 */
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
