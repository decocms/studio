/**
 * O dossiê de uma hipótese: o que se afirma, o que sustenta, o que contradiz,
 * até onde foi validado e o teste recomendado — com o tipo de cada afirmação.
 *
 * É o produto final da investigação: quem lê precisa ver de onde veio cada
 * conclusão e o que ainda falta. Função pura (markdown), usada pela tela
 * ("Copiar dossiê"), pela tool `get_ux_dossier` e pelo revisor independente,
 * que lê SÓ isto — não o raciocínio que gerou a hipótese.
 */

import { CLAIM_WORD } from "./claims.ts";
import { factIndex, factLine, type UxFact } from "./facts.ts";
import { LIFECYCLE_WORD, lifecycleOf, validationOf } from "./lifecycle.ts";
import { controlNote } from "./losses.ts";
import type { HypothesisReview } from "./review.ts";
import { CATEGORY_WORD } from "./tree.ts";
import type { UxHypothesis, UxOpportunity } from "./types.ts";

const LEVEL_WORD = {
  confirmada: "Confirmada",
  refutada: "Refutada",
  conflito: "Testes em conflito",
  inconclusiva: "Não decidiu",
  nao_testada: "Não testada",
} as const;

const RELEVANCE_WORD = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
  sem_relevancia: "Sem relevância",
  nao_avaliada: "Não avaliada",
} as const;

const pct = (v: number, digits = 1) =>
  `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: digits })}%`;
const int = (v: number) => Math.round(v).toLocaleString("pt-BR");

/** A conclusão, em uma frase, pelo estado — nunca afirma causa. */
export function conclusionOf(
  h: Pick<UxHypothesis, "verification" | "lifecycle" | "experiment">,
): string {
  switch (lifecycleOf(h)) {
    case "pronta_para_experimento":
      return `Existe uma condição real que atinge gente suficiente e dá pra medir em ${h.experiment?.weeks ?? "?"} semana(s). A hipótese está fundamentada pra um teste, mas ainda não há evidência de que a mudança aumenta a conversão.`;
    case "relevancia_avaliada":
      return "A condição existe e foi medida, mas ainda não está pronta pro teste (relevância baixa, teste que não fecha ou dados frágeis).";
    case "condicao_confirmada":
      return "A condição existe; falta medir quantas pessoas ela atinge.";
    case "refutada":
      return "Os testes desmentiram a hipótese. Ela fica como registro e aponta outras linhas de investigação.";
    case "sem_relevancia":
      return "A condição existe, mas atinge pouca gente: não vale um teste agora.";
    case "bloqueada":
      return "Não deu pra investigar: faltou acesso à página, ao código ou ao dado.";
    case "inconclusiva":
      return "O que se conseguiu conferir não decidiu a hipótese.";
    default:
      return "Ainda não investigada.";
  }
}

/**
 * "O gap se repete?" numa linha: o revisor só lê o dossiê, e sem isto ele
 * propunha "é o tráfego pago" como explicação mais simples quando os recortes
 * já mostravam o gap dentro de cada canal (numa loja, 15/11).
 */
function drilldownLine(o: UxOpportunity): string {
  const d = o.drilldown;
  if (!d) return "";
  const parts: string[] = [];
  const adj = d.mix_adjusted_gap_pp.canal;
  if (adj != null) {
    parts.push(
      `com a mistura de canais do outro dispositivo o gap vai de ${d.gap_pp} para ${adj} pp`,
    );
  }
  const c = d.consistency.canal;
  if (c) parts.push(`o gap aparece em ${c.same} de ${c.total} canais`);
  const v = d.consistency.visitante;
  if (v) parts.push(`em ${v.same} de ${v.total} grupos (nova × recorrente)`);
  return parts.length > 0
    ? `Recortes do GA4: ${parts.join("; ")} — fato observado.`
    : "";
}

export function buildDossier(input: {
  hypothesis: UxHypothesis;
  opportunity: UxOpportunity | null;
  /**
   * O livro de fatos do diagnóstico: cada afirmação traz os dados que cita.
   * O revisor independente lê o dado, não a frase do modelo sobre ele.
   */
  facts?: UxFact[];
  /** A revisão independente; ausente quando o dossiê é o que o revisor lê. */
  review?: HypothesisReview | null;
  /** A meta da rodada, como contexto. Ausente = o dossiê de sempre. */
  objective?: string | null;
}): string {
  const { hypothesis: h, opportunity: o } = input;
  const tree = h.tree ?? null;
  const state = lifecycleOf(h);
  const v = h.validation ?? validationOf(h.verification);
  const lines: string[] = [];
  const section = (title: string, body: string[]) => {
    const content = body.filter(Boolean);
    if (content.length === 0) return;
    lines.push(`## ${title}`, "", ...content, "");
  };

  lines.push(
    `# Dossiê — ${h.title}`,
    "",
    `**Estado:** ${LIFECYCLE_WORD[state]}${tree ? ` · ${CATEGORY_WORD[tree.category]}` : ""}`,
    "",
  );
  const goal = input.objective?.trim();
  if (goal) lines.push(`**Meta da rodada:** ${goal}`, "");

  if (o) {
    const m = o.measured;
    section("Problema relacionado", [
      o.title,
      m
        ? `Medido: ${m.label} no ${m.device === "mobile" ? "celular" : "computador"} ${pct(m.rate)} (n=${int(m.n)})${m.comp ? ` x ${pct(m.comp.rate)} no ${m.comp.device === "mobile" ? "celular" : "computador"}` : ""} — fato observado.`
        : "",
      o.metric?.control
        ? `Tipo da perda: ${o.metric.control}. ${controlNote(o.metric.control, o.metric.segment?.key)}`
        : "",
      o.reliability ? `Confiança nos dados: ${o.reliability.level}.` : "",
      drilldownLine(o),
    ]);
  }

  section("1. Hipótese", [
    tree?.statement ?? `${h.title}. ${h.why}`,
    tree?.segmento ? `Quem: ${tree.segmento}.` : "",
    tree?.metrica.key
      ? `Métrica que deve mudar: ${tree.metrica.key} (${tree.metrica.direcao}${tree.metrica.efeito_esperado_pp != null ? `, ~${tree.metrica.efeito_esperado_pp} pp` : ""}).`
      : "",
  ]);

  const book = input.facts ? factIndex(input.facts) : null;
  const cited = (ids: string[] | undefined) =>
    book
      ? (ids ?? [])
          .map((id) => book.get(id))
          .filter((f): f is UxFact => !!f)
          .map((f) => `\n  - dado: ${factLine(f)}`)
          .join("")
      : "";
  const favor = (tree?.a_favor ?? []).map(
    (c) => `- ${c.text} _(${CLAIM_WORD[c.label]})_${cited(c.facts)}`,
  );
  if (tree?.por_que_no_dispositivo) {
    favor.push(
      `- O que muda entre as telas: ${tree.por_que_no_dispositivo}${cited(tree.fatos_contraste)}`,
    );
  }
  const confirmed = (h.verification?.runs ?? [])
    .filter((r) => r.outcome === "confirma" && r.measures_cause !== false)
    .map(
      (r) =>
        `- ${r.check.claim}: ${r.observed.split("\n")[0]!.slice(0, 200)} _(fato observado, ${r.check.stage === "live" ? "loja no ar" : r.check.stage === "repo" ? "código" : "dados"})_`,
    );
  const rel = h.relevance;
  section("2. Evidências encontradas", [
    ...favor,
    ...confirmed,
    rel
      ? `- A mudança atinge ${int(rel.affected_week)} visualizações por semana (${rel.affected_pct}% da página)${rel.basis ? `: ${rel.basis}` : "."} _(fato observado)_`
      : "",
    ...(rel?.signals ?? []).map(
      (s) => `- ${s.label}: ${s.value} _(fato observado)_`,
    ),
  ]);

  const against = (tree?.contra ?? []).map(
    (c) => `- ${c.text} _(${CLAIM_WORD[c.label]})_${cited(c.facts)}`,
  );
  const refuting = (h.verification?.runs ?? [])
    .filter((r) => r.outcome === "desmente" && r.measures_cause !== false)
    .map((r) => `- ${r.check.claim}: desmentido _(fato observado)_`);
  const dataIssues = (o?.reliability?.checks ?? [])
    .filter((c) => c.severity === "atencao" || c.severity === "bloqueia")
    .map((c) => `- ${c.label}: ${c.text}`);
  section("3. Evidências contrárias e limitações", [
    ...against,
    ...refuting,
    ...dataIssues,
    "- Associação não é causa: nada aqui mostra que a mudança aumenta a conversão.",
    ...(input.review?.falhas ?? []).map((f) => `- Revisor: ${f}`),
  ]);

  section("4. Validações", [
    `- Existência do problema: ${LEVEL_WORD[v.existencia]}`,
    `- Implementação: ${LEVEL_WORD[v.implementacao]}`,
    `- Relevância: ${RELEVANCE_WORD[v.relevancia]}`,
    "- Efeito causal: Não testado (só um A/B responde)",
  ]);

  const e = h.experiment;
  if (e) {
    section("5. Experimento recomendado", [
      `- Controle: ${e.controle}`,
      `- Variante: ${e.variante}`,
      `- Métrica primária: ${e.metrica_primaria.label} (hoje ${pct(e.baseline, 2)})`,
      e.secundarias.length > 0
        ? `- Secundárias: ${e.secundarias.join("; ")}`
        : "",
      `- Guardrails: ${e.guardrails.join("; ")}`,
      `- Método: ${e.metodo}`,
      e.measurable
        ? `- Amostra: ${int(e.n_per_group)} por grupo, ${e.weeks} semana(s) com ${int(e.weekly_eligible)} elegíveis/semana; efeito mínimo ${e.mde_pp} pp.`
        : `- Não mensurável agora: ${e.mde_pp} pp levaria mais de 8 semanas.`,
    ]);
  }

  if (input.review) {
    section("Revisão independente", [
      `Explica o gap? ${input.review.explica_o_gap}. ${input.review.resposta}`,
    ]);
  }

  section("Conclusão", [conclusionOf(h)]);
  return lines.join("\n").trim();
}
