/**
 * De cada oportunidade às hipóteses do porquê. A oportunidade em si é uma
 * perda medida em código (loss-opportunities.ts); aqui o modelo só propõe a
 * causa.
 *
 *   1. `generateOpportunityHypotheses`: um lote de oportunidades por chamada.
 *      Pra cada uma, de 0 a 3 hipóteses: por que acontece → o que os dados
 *      mostrariam se fosse isso, e se mostram → o que fazer → quais lojas do
 *      benchmark já fazem assim. Toda afirmação cita os fatos (facts.ts) e o
 *      código confere.
 *   2. `challengeHypotheses`: outra chamada tenta derrubar cada hipótese com os
 *      mesmos fatos. Em 12/11 saiu "reordenar os tamanhos" apoiada em clique
 *      morto e raiva da página INTEIRA, num print de produto quase esgotado,
 *      enquanto os produtos de grade quebrada convertiam mais que os outros.
 *   3. Oportunidade que fica sem nenhuma hipótese de pé sai da tela, e a
 *      próxima reserva tenta o lugar dela (ver `fallenReason`).
 *
 * O que o modelo NÃO decide: a perda, a conta (money.ts), a ordem, o rótulo de
 * "fato" (claims.ts) e quais lojas existem — loja que não foi capturada nesta
 * análise é descartada.
 */

import type { HypothesisDraft } from "../storage/plan-engine.ts";
import { normalizeDomain } from "./benchmark.ts";
import { CLAIM_WORD } from "./claims.ts";
import {
  checkGrounding,
  factBook,
  factBookForPrompt,
  factIndex,
  factLine,
  parseFactIds,
  type UxFact,
} from "./facts.ts";
import { HYPOTHESES_MODEL, stockNote } from "./hypotheses.ts";
import { extractJsonObject } from "./json.ts";
import {
  type KnowledgeBlock,
  knowledgeForPrompt,
  resolveCitations,
  selectKnowledge,
} from "./knowledge/select.ts";
import { type KnowledgeEntry, SOURCE_TYPE_LABEL } from "./knowledge/types.ts";
import { markStale } from "./knowledge/validity.ts";
import { controlNote } from "./losses.ts";
import {
  type MeasuredMetric,
  metricsForPrompt,
  type UxMetricKey,
} from "./metrics.ts";
import { pageSpec } from "./page-types.ts";
import type { Llm, LlmContentPart, LlmTier, LlmUsage } from "./ports.ts";
import { type DataReliability, SEGMENT_WORD } from "./reliability.ts";
import {
  CATEGORY_WORD,
  claimsMarkdown,
  type DiscardedCategory,
  type HypothesisTree,
  parseDiscarded,
  parseTree,
  targetsOf,
  type UxClaim,
} from "./tree.ts";
import { triage, triageKey } from "./triage.ts";
import type {
  DiagnosisEvidence,
  HypothesisBenchmark,
  OpportunityDraft,
  UxOpportunity,
  UxPageType,
} from "./types.ts";

/** Teto de hipóteses do porquê por oportunidade (o modelo pode dar menos). */
const MAX_HYPOTHESES_PER_OPPORTUNITY = 3;

/** Oportunidades por chamada (e por step da Workflow) no passo das hipóteses. */
export const HYPOTHESES_BATCH = 4;

/**
 * Quantas reservas tentam o lugar de uma oportunidade que caiu. Cada tentativa
 * é uma chamada de hipóteses + uma de revisão; sem reserva que pare de pé, a
 * vaga fica vazia (uma oportunidade honesta vale mais que duas com uma falsa).
 */
export const MAX_REPLACEMENT_TRIES = 2;

const clamp01 = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
};

export const text = (v: unknown) => (v == null ? "" : String(v).trim());

export function parseJson(raw: string, what: string): Record<string, unknown> {
  const json = extractJsonObject(raw);
  if (!json) throw new Error(`o modelo não devolveu JSON de ${what}`);
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `JSON de ${what} inválido: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Os prints da nossa PDP (primeira tela dos dois, página inteira do celular). */
async function pageImages(
  evidence: DiagnosisEvidence,
  mediaUrl: (url: string) => Promise<string> = async (url) => url,
): Promise<LlmContentPart[]> {
  const parts: LlmContentPart[] = [];
  for (const c of evidence.captures) {
    const stock = stockNote(c.stock);
    if (c.fold_url) {
      parts.push({
        type: "text",
        text: `Print da primeira tela — ${c.device}, ${c.url}${stock}:`,
      });
      parts.push({ type: "image", url: await mediaUrl(c.fold_url) });
    }
    if (c.full_url && c.device === "mobile") {
      parts.push({
        type: "text",
        text: `Página inteira (cortada) — ${c.device}${stock}:`,
      });
      parts.push({ type: "image", url: await mediaUrl(c.full_url) });
    }
  }
  return parts;
}

/** A linha do rodapé de uma oportunidade que saiu da tela. */
export function fallenLimit(title: string, reason: string): string {
  return `Tiramos "${title}" da tela: nenhuma hipótese parou de pé (${reason}).`;
}

/** O rodapé das reservas que não entraram na tela. */
export function reservesLimit(reserves: OpportunityDraft[]): string | null {
  return reserves.length > 0
    ? `Também vimos, com menos valor, e ficaram de fora: ${reserves.map((o) => `"${o.title}"`).join("; ")}.`
    : null;
}

/**
 * A métrica medida e a confiabilidade, numa linha pro prompt das hipóteses e
 * da revisão: o modelo escreve a causa sabendo se o próprio problema se
 * sustenta. Vazio quando a oportunidade não tem nenhum dos dois.
 */
function measuredForPrompt(
  m: MeasuredMetric | null | undefined,
  r: DataReliability | null | undefined,
): string {
  const parts: string[] = [];
  if (m) {
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    parts.push(
      `medido por nós: ${m.label} no ${m.device} ${pct(m.rate)} (n=${m.n})${m.comp ? ` x ${m.comp.device} ${pct(m.comp.rate)} (n=${m.comp.n}), gap ${m.gap_pp} pp` : ""}`,
    );
  }
  if (r) {
    const issues = r.checks
      .filter(
        (c) =>
          c.severity === "atencao" ||
          c.severity === "bloqueia" ||
          c.code === "premissa",
      )
      .map((c) => c.text);
    parts.push(
      `confiança nos dados: ${r.level}${issues.length > 0 ? ` (${issues.join(" ")})` : ""}`,
    );
  }
  return parts.length > 0 ? ` [${parts.join("; ")}]` : "";
}

// ── 2. Hipóteses de cada oportunidade ────────────────────────────────────────

const HYPOTHESES_SYSTEM_PDP = `Você é analista sênior de CRO e UX de e-commerce. Para cada oportunidade de uma página de produto (PDP), monte a ÁRVORE de hipóteses do porquê: explicações concorrentes DA PERDA que a oportunidade mede (o título dela), cada uma com o que a apoia, o que a contradiz e como provar que ela está errada.

A OPORTUNIDADE É A PERDA, A HIPÓTESE É A CAUSA DELA:
- O título da oportunidade é uma perda medida numa etapa ("No celular, 50% de quem entra na página não abre nenhum produto"). Toda hipótese é uma causa DESSA perda: age nessa etapa, nessa página, pra essa gente.
- As "observações" da oportunidade são o que MUDA entre as telas, medido por nós (posição na 1ª tela, fato da página, clique morto do mesmo elemento). São ponto de partida, não causa: uma observação só vira hipótese se houver um mecanismo que a ligue a ESTA perda. Uma causa sem observação entra se age na MESMA etapa e os fatos a sustentam.
- O resumo da oportunidade diz quanto do gap a mistura de público já explica e quanto SOBRA pra página. A hipótese explica o que sobra; "o celular recebe mais tráfego de baixa intenção" já foi descontado nessa conta e só cabe se trouxer algo que a mistura de canal e de nova × recorrente não mede.
- Uma causa de outra etapa, de outra página ou de outro público é de outra oportunidade: não escreva.

AS SEIS CATEGORIAS ("categoria") — considere todas, mas só escreva as que agem NESTA perda:
- ux: layout, ordem, componentes, navegação, o que aparece onde.
- performance: velocidade, carregamento, página que pula.
- confianca: segurança, avaliações, troca e devolução, informação que falta pra decidir.
- comercial: preço, frete, parcelamento, estoque — e como a página os mostra.
- trafego: quem chega (canal, campanha, nova × recorrente) e com que intenção.
- tecnologia: bug, evento que não dispara, componente diferente entre celular e computador.
Concorrentes valem, inclusive as que NÃO se resolvem mexendo na página (ex.: "o celular recebe mais tráfego de campanha, que converte menos em qualquer tela" — use os Recortes), desde que expliquem ESTA perda.

CADA HIPÓTESE:
- "categoria": uma das seis.
- "causa": a causa suspeita, numa frase ("A escolha de tamanho fica abaixo da primeira tela").
- "intervencao": a mudança na página que testaria a causa, concreta o bastante pra desenhar numa tela. null SÓ em trafego ou comercial quando não há o que mudar na página.
- "resultado": o que muda se a intervenção funcionar ("viu → carrinho no celular sobe").
- "mecanismo": POR QUE a intervenção mudaria o resultado (comportamento ou técnica). Sem mecanismo plausível, não escreva a hipótese.
- "a_favor" e "contra": os dados que apoiam e que contradizem, um por item, cada um com "fatos" (os ids citados, ["F12"]) e "tipo": "fato_observado" (está nos fatos citados), "evidencia_indireta" (benchmark, estudo de fora, sinal que sugere), "inferencia" (interpretação sua). Nós conferimos: "fato_observado" sem fato citado, com id que não existe, com fato lido por IA ou com número que não está no fato vira "inferencia". Procure o "contra" com o mesmo cuidado do "a favor". O número tem que ser DA PARTE da hipótese: total da página inteira não sustenta hipótese de uma parte.
- "segmento": quem é afetado (dispositivo, tipo de produto, canal).
- "metrica": a etapa DA OPORTUNIDADE (a mesma "key" que está nela), "direcao" ("sobe"|"desce") e "efeito_esperado_pp" (pequeno e defensável, 0,3 a 3). Hipótese que mexe em outra etapa é de outra oportunidade.
- "como_verificar": o que, na página ou no código, mostraria que a causa existe.
- "como_refutar": o que mostraria que ela está ERRADA. Obrigatório.
- "prediction": se a causa for real, o que ESTES dados mostrariam; "check": "apoia" | "contradiz" | "sem_dado"; "check_note": a linha do dado que decide, com número.
- "alvo": onde na página — { "kind": "part", "key": "price"|"size_selector"|"buy_button"|"shipping"|"first_recommendation" }, { "kind": "element", "key": "<root|el da tabela de elementos>" } ou { "kind": "section", "key": "<nome da seção>" }. null se não é uma parte.
- "posicao_depois": "primeira_tela" se a intervenção traz o alvo pra primeira tela; senão "mesma".
- "relacoes": ligações com outras hipóteses da MESMA oportunidade, pelo rank (1, 2…): "causa_comum" (as duas vêm da mesma causa — não conte o ganho duas vezes), "concorrente" (se uma é verdade, a outra perde força), "complementar".
- "esforco": 1 (CSS/texto), 2 (componente), 3 (fluxo/dados novos).
- "where": parte/componente onde mexer; "confidence": 0.0-1.0.
- "benchmark": as lojas capturadas que já fazem algo parecido, e como (copie do que está descrito). Só lojas da lista. Nenhuma? Lista vazia.
- "fontes_conhecimento": os rótulos [K…] da base que você usou. Só os que estão no bloco.

O TIPO DA PERDA DECIDE O QUE É CAUSA (vem marcado em cada oportunidade):
- "absoluta": quanto não passa da etapa, sem comparação. Uma causa que vale pras duas telas explica; "é igual no computador" não é argumento contra.
- "dispositivo": a etapa é pior num dispositivo que no outro. Só explica uma causa que MUDA entre as telas (a parte cai abaixo da 1ª tela só no celular; o componente do celular é outro). Toda hipótese aqui tem "por_que_no_dispositivo": o que é diferente entre as telas, com o dado, e "fatos_contraste": os ids que mostram a diferença, ao menos um fato do celular e um do computador. Causa igual nas duas telas não explica a diferença — sem isso, não escreva a hipótese.
- "segmento": ver abaixo.

OPORTUNIDADE DE UM SEGMENTO (marcada "SEGMENTO CULPADO"):
- O problema é que ESSE segmento converte menos que o resto. Uma causa que atinge todo mundo do mesmo jeito (um pop-up que abre pra todos, um botão abaixo da dobra pra todos) NÃO explica isso — explica, no máximo, o dispositivo inteiro, que é outro problema.
- Toda hipótese aqui tem "por_que_no_segmento": por que a causa pesa MAIS nesse segmento, com o dado que mostra isso (ex.: o anúncio leva a um produto que a PDP mostra esgotado; quem chega de campanha vê o pop-up porque nunca fechou antes). Sem isso, não escreva a hipótese.

POR OPORTUNIDADE:
- De 0 a 3 hipóteses, a mais provável primeiro. Nenhuma boa? Lista vazia — melhor que enchimento. Uma explicação forte vale mais que três fracas.
- "categorias_descartadas": pra cada categoria sem hipótese, uma linha com o porquê ("performance: LCP do celular dentro do limite nos dados").

REGRAS:
- Se o "check" der "contradiz", não escreva a hipótese.
- Nenhuma intervenção se repete na lista inteira, nem entre oportunidades.
- Prefira o padrão que a cliente já conhece (o que as lojas capturadas fazem) a inventar componente. Não mude convenção sem dado forte (ex.: a ordem PP→GG).
- O print marcado como GRADE QUEBRADA ou ESGOTADO mostra o estado de falta: hipótese sobre ele vale só pra produto em falta, e diga isso.
- Associação não é causa: a hipótese é pra virar teste A/B, não conclusão.
- "Quem usa Y converte mais, então mostrar mais Y sobe a conversão" não é mecanismo: quem usa Y escolheu usar. Sem um dado que mostre gente querendo usar Y e não achando, não escreva a hipótese.
- Clique morto num elemento que "leva pra" outra página é a página nova demorando, não prova de botão quebrado.
- Não invente dado nem resultado de teste. Benchmark e estudo de fora são sinal, não prova. Os dados estão nos "Fatos", um por linha com id: o que não está lá não foi medido, e comportamento que nenhum fato mostra (o que acontece ao tocar num botão, se um elemento existe na outra tela) é inferência, não fato. As "Sondas" mostram o que a página FAZ: a página aberta sem fechar pop-up (que camada cobre quanto da 1ª tela, e se cobre preço e botão de compra) e o que acontece ao tocar nos elementos com muito clique morto. A captura de sempre fecha os pop-ups antes de medir: pop-up só é fato pela sonda. Se uma sonda já mostra que o toque funciona, "o elemento não responde" está desmentido.
- Português do Brasil, frases curtas, sem jargão.
- Não proponha mudar preço, frete ou estoque — só como a página os mostra.`;

/**
 * O prompt das hipóteses pra este tipo de página (a PDP fica como era). Com a
 * meta da rodada, ela entra no fim como contexto; sem meta, o prompt é o mesmo
 * de antes, byte a byte.
 */
export function hypothesesSystem(
  pageType: UxPageType = "pdp",
  objective?: string | null,
): string {
  const base = pageHypothesesSystem(pageType);
  const goal = objective?.trim();
  return goal ? `${base}\n\n${objectiveSection(goal)}` : base;
}

/** A meta escrita pela equipe: contexto pra escolher, nunca dado nem conta. */
function objectiveSection(goal: string): string {
  return `META DA LOJA NESTA RODADA (texto da equipe, entre aspas; é contexto, não dado):
"${goal.replace(/\s+/g, " ")}"
- Entre causas que os fatos sustentam igual, prefira a que mais pesa nessa meta, e diga a ligação no "mecanismo".
- A meta não é fato: não cite número dela, não invente dado pra ligar a hipótese à meta e não descarte uma causa forte só porque ela não fala da meta.
- A perda, o dinheiro e a ordem continuam calculados fora de você.`;
}

function pageHypothesesSystem(pageType: UxPageType): string {
  if (pageType === "pdp") return HYPOTHESES_SYSTEM_PDP;
  const spec = pageSpec(pageType);
  const parts = Object.keys(spec.parts);
  return HYPOTHESES_SYSTEM_PDP.replace(
    "Para cada oportunidade de uma página de produto (PDP)",
    `Para cada oportunidade d${spec.noun.startsWith("o ") ? "o" : "a"} ${spec.label.toLowerCase()} (${spec.description})`,
  )
    .replace(
      '{ "kind": "part", "key": "price"|"size_selector"|"buy_button"|"shipping"|"first_recommendation" }, ',
      parts.length > 0
        ? `{ "kind": "part", "key": "${parts.join('"|"')}" }, `
        : "",
    )
    .replace(
      '("A escolha de tamanho fica abaixo da primeira tela")',
      pageType === "busca"
        ? '("O primeiro resultado da busca não é o produto que se pediu")'
        : pageType === "categoria"
          ? '("O filtro fica escondido atrás de um botão")'
          : pageType === "home"
            ? '("O destaque da primeira tela não leva a produto")'
            : '("O frete só aparece depois de preencher o endereço")',
    )
    .replace(
      "(ex.: o anúncio leva a um produto que a PDP mostra esgotado; quem chega de campanha vê o pop-up porque nunca fechou antes)",
      "(ex.: quem chega de campanha cai numa página que não mostra o que o anúncio prometeu; quem chega de campanha vê o pop-up porque nunca fechou antes)",
    )
    .replace(
      " Não mude convenção sem dado forte (ex.: a ordem PP→GG).",
      " Não mude convenção sem dado forte.",
    )
    .replace(
      "\n- O print marcado como GRADE QUEBRADA ou ESGOTADO mostra o estado de falta: hipótese sobre ele vale só pra produto em falta, e diga isso.",
      spec.dataOnly
        ? '\n- Não há print nem heatmap desta página: a hipótese se apoia no funil, nos recortes e no conhecimento; diga isso no "contra" quando faltar ver a página.'
        : "",
    );
}

export interface OpportunityHypothesesResult {
  /** id da oportunidade → hipóteses validadas, já reordenadas. */
  byOpportunity: Map<string, HypothesisDraft[]>;
  /** As que caíram e por quê. Vira "limite" na tela, não some. */
  dropped: string[];
  /** As mesmas de `dropped`, por id da oportunidade (a falha da revisão não entra). */
  droppedBy: Map<string, string[]>;
  /** Por oportunidade: as categorias sem hipótese e por quê. */
  discarded?: Map<string, DiscardedCategory[]>;
}

/**
 * Por que a oportunidade ficou sem nenhuma hipótese de pé, ou null se ficou
 * com alguma. Em 13/11 uma loja mostrou em 1º lugar "preço empurrado por
 * 4 banners", com R$ 1,18 mi/mês, e a revisão tinha derrubado a única hipótese
 * com os números da própria oportunidade (o preço estava em y=699 numa tela de
 * 844). Oportunidade assim não vai pra tela: a premissa dela não parou de pé.
 */
export function fallenReason(
  result: OpportunityHypothesesResult,
  opportunityId: string,
): string | null {
  if ((result.byOpportunity.get(opportunityId) ?? []).length > 0) return null;
  const reasons = result.droppedBy.get(opportunityId) ?? [];
  return reasons.length > 0
    ? reasons.join("; ")
    : "nenhuma hipótese que estes dados sustentem";
}

/**
 * As hipóteses de um lote de oportunidades: uma chamada escreve, outra tenta
 * derrubar (challengeHypotheses). Devolve o mapa id da oportunidade →
 * hipóteses que ficaram de pé, e as que caíram.
 */
export async function generateOpportunityHypotheses(opts: {
  llm: Llm;
  domain: string;
  evidence: DiagnosisEvidence;
  opportunities: UxOpportunity[];
  onUsage: (u: LlmUsage) => void;
  /** Base de conhecimento (loja + curada); escolhe pelas partes em jogo. */
  knowledge?: KnowledgeEntry[];
  /**
   * Por oportunidade: as causas que já caíram, com o motivo (reinvestigate.ts).
   * A rodada nova não pode repetir nem reescrever nenhuma delas.
   */
  tried?: Map<string, string[]>;
  /** A meta da rodada (`objective_statement`): contexto no prompt. */
  objective?: string | null;
  /**
   * Assina as URLs dos prints da org: o modelo baixa a imagem pela rota de
   * mídia, que só serve objeto de org com assinatura. Ausente = como estão.
   */
  mediaUrl?: (url: string) => Promise<string>;
}): Promise<OpportunityHypothesesResult> {
  const { evidence, opportunities } = opts;
  const spec = pageSpec(evidence.page_type);
  const knowledge = selectKnowledge({
    // Veredito de uma página que mudou vai como histórico (validity.ts).
    entries: markStale(opts.knowledge ?? [], evidence),
    areas: opportunities.map((o) => o.area),
    pageType: spec.key,
  });
  const knowledgeText = knowledgeForPrompt(knowledge);
  const facts = factBook(evidence);
  const captured = evidence.benchmark.map((b) => b.domain);
  const list = opportunities
    .map((o) => {
      const sources = o.sources
        .map((s) => `${s.source}: ${s.metric} = ${s.value}`)
        .join("; ");
      const seg = o.metric?.segment;
      const control = o.metric?.control;
      const obs = (o.observations ?? [])
        .map(
          (x) =>
            `  - observação: ${x.text}${x.facts.length > 0 ? ` [${x.facts.join(", ")}]` : ""}`,
        )
        .join("\n");
      const tried = (opts.tried?.get(o.id) ?? [])
        .map(
          (x) =>
            `  - JÁ TENTADO E CAIU (não repita, nem com outras palavras; um fato de "Verificações" mostra o que se viu): ${x}`,
        )
        .join("\n");
      return `- [${o.rank}] (${o.area}, ${o.device}) PERDA: ${o.title} — ${o.summary}${o.metric ? ` Etapa: ${o.metric.key}.` : ""}${control ? ` Tipo: ${control}. ${controlNote(control, seg?.key)}` : ""} Dados: ${sources}${measuredForPrompt(o.measured, o.reliability)}${seg ? ` SEGMENTO CULPADO: ${seg.dim} = ${seg.key} (toda hipótese precisa explicar por que pesa MAIS nele).` : ""}${obs ? `\n${obs}` : ""}${tried ? `\n${tried}` : ""}`;
    })
    .join("\n");

  const raw = await opts.llm(
    {
      tier: HYPOTHESES_MODEL,
      maxTokens: 20_000,
      temperature: 0.3,
      timeoutMs: 300_000,
      systemPrompt: hypothesesSystem(spec.key, opts.objective),
      userPrompt: `Loja: ${opts.domain}. Página analisada: ${spec.key === "pdp" ? "PDP (página de produto)" : `${spec.label} — ${spec.description}`}.

${factBookForPrompt(facts, evidence.gaps)}

## Concorrentes capturados nesta análise (só estes valem em "benchmark")
${captured.length > 0 ? captured.map((d) => `- ${d}`).join("\n") : 'Nenhum — o benchmark não carregou. Deixe todo "benchmark" vazio.'}

${knowledgeText ? `${knowledgeText}\n\n` : ""}## Oportunidades (escreva as hipóteses de cada uma)
${list}

## Etapas ("metrica.key": a da oportunidade)
${metricsForPrompt(spec.key)}

Responda SÓ este JSON:
{
  "opportunities": [
    {
      "rank": 1,
      "categorias_descartadas": [ { "categoria": "performance", "por_que": "..." } ],
      "hypotheses": [
        {
          "categoria": "ux",
          "causa": "...", "intervencao": "..." | null, "resultado": "...", "mecanismo": "...",
          "a_favor": [ { "texto": "...", "fatos": ["F12"], "tipo": "fato_observado" } ],
          "contra": [ { "texto": "...", "fatos": [], "tipo": "inferencia" } ],
          "segmento": "...",
          "metrica": { "key": "${spec.defaultMetric}", "direcao": "sobe", "efeito_esperado_pp": 1 },
          "como_verificar": "...", "como_refutar": "...",
          "prediction": "...", "check": "apoia" | "contradiz" | "sem_dado", "check_note": "...",
          "alvo": ${Object.keys(spec.parts).length > 0 ? `{ "kind": "part", "key": "${Object.keys(spec.parts)[0]}" }` : '{ "kind": "section", "key": "..." }'} | null,
          "posicao_depois": "primeira_tela" | "mesma",
          "relacoes": [ { "rank": 2, "tipo": "concorrente" } ],
          "esforco": 1 | 2 | 3,
          "por_que_no_segmento": "..." | null,
          "por_que_no_dispositivo": "..." | null,
          "fatos_contraste": ["F12", "F40"],
          "where": "...", "confidence": 0.0-1.0,
          "fontes_conhecimento": ["K1"],
          "benchmark": [ { "domain": "loja.com", "what_they_do": "como essa loja resolve, numa frase" } ]
        }
      ]
    }
  ]
}`,
      contentParts: await pageImages(evidence, opts.mediaUrl),
    },
    opts.onUsage,
  );

  const parsed = parseOpportunityHypotheses(
    raw,
    opportunities,
    evidence,
    knowledge,
    facts,
  );
  return challengeHypotheses({
    llm: opts.llm,
    evidence,
    opportunities,
    result: parsed,
    onUsage: opts.onUsage,
    knowledgeText,
  });
}

/**
 * A prova de que a causa muda entre as telas: os fatos citados existem, há
 * ao menos um do celular e um do computador, e os números da frase estão
 * neles. Devolve os ids, ou o motivo de cair.
 */
function deviceContrast(
  why: string,
  rawIds: unknown,
  book: Map<string, UxFact>,
): string[] | string {
  const g = checkGrounding(why, parseFactIds(rawIds), book);
  if (g.unknown.length > 0) {
    return `a diferença entre as telas cita ${g.unknown.join(", ")}, que não existe`;
  }
  const devices = new Set(g.facts.map((f) => f.device));
  if (!devices.has("mobile") || !devices.has("desktop")) {
    return "a diferença entre as telas não cita um fato do celular e um do computador";
  }
  if (g.unsupported.length > 0) {
    return `a diferença entre as telas usa ${g.unsupported.join(", ")}, que não está nos fatos citados`;
  }
  return g.facts.map((f) => f.id);
}

/** A mesma etapa (a da PDP no GA4 e no Deco Analytics é uma só). */
const SAME_STEP: UxMetricKey[][] = [
  ["produto_carrinho", "pdp_carrinho"],
  // Abrir um produto da página = clicar num produto da vitrine dela.
  ["pagina_produto", "lista_produto"],
];
const sameStep = (a: UxMetricKey, b: UxMetricKey) =>
  a === b || SAME_STEP.some((g) => g.includes(a) && g.includes(b));

/** Sem dado pra conferir a previsão, a hipótese não passa disso. */
const UNCHECKED_CONFIDENCE = 0.4;

const asCheck = (v: unknown): "apoia" | "contradiz" | "sem_dado" => {
  const t = text(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (t.startsWith("apoia")) return "apoia";
  if (t.startsWith("contradiz")) return "contradiz";
  return "sem_dado";
};

/** Exportado pra teste. */
export function parseOpportunityHypotheses(
  raw: string,
  opportunities: UxOpportunity[],
  evidence: DiagnosisEvidence,
  knowledge?: KnowledgeBlock,
  facts: UxFact[] = factBook(evidence),
): OpportunityHypothesesResult {
  const parsed = parseJson(raw, "hipóteses");
  const book = factIndex(facts);
  const byRank = new Map(opportunities.map((o) => [o.rank, o]));
  const urlOf = new Map(
    evidence.benchmark.map((b) => [bareDomain(b.domain), b.url]),
  );
  const out = new Map<string, HypothesisDraft[]>();
  const dropped: string[] = [];
  const droppedBy = new Map<string, string[]>();
  const discarded = new Map<string, DiscardedCategory[]>();
  const targets = targetsOf(evidence);

  for (const item of Array.isArray(parsed.opportunities)
    ? parsed.opportunities
    : []) {
    const r = item as Record<string, unknown>;
    const opportunity = byRank.get(Number(r.rank));
    if (!opportunity) continue;
    const drafts: HypothesisDraft[] = [];
    const drop = (reason: string) => {
      dropped.push(reason);
      droppedBy.set(opportunity.id, [
        ...(droppedBy.get(opportunity.id) ?? []),
        reason,
      ]);
    };
    // O modelo numera pela posição; depois das que caem, as relações seguem o rank novo.
    const newRank = new Map<number, number>();
    for (const [index, h] of (Array.isArray(r.hypotheses)
      ? r.hypotheses
      : []
    ).entries()) {
      const x = (h ?? {}) as Record<string, unknown>;
      const tree = parseTree(x, targets, index + 1, book);
      if (typeof tree === "string") {
        if (tree !== "sem causa") drop(tree);
        continue;
      }
      const title = tree.causa;
      // Oportunidade de um segmento: a causa tem que pesar mais nele.
      const segment = opportunity.metric?.segment;
      const whySegment = text(x.por_que_no_segmento);
      if (segment && !whySegment) {
        drop(
          `"${title}" (vale pra todo mundo: não explica por que ${SEGMENT_WORD[segment.key] ?? segment.key} converte menos)`,
        );
        continue;
      }
      if (segment) tree.por_que_no_segmento = whySegment;
      // A hipótese mede a etapa da oportunidade, ou é de outra.
      const own = opportunity.metric?.key ?? null;
      if (own) {
        const said = tree.metrica.key;
        if (said && !sameStep(said, own)) {
          drop(
            `"${title}" (mexe em outra etapa — ${said} — e a oportunidade é ${own})`,
          );
          continue;
        }
        tree.metrica = { ...tree.metrica, key: own };
      }
      // Perda de dispositivo só se explica pelo que muda entre as telas.
      const whyDevice = text(x.por_que_no_dispositivo);
      if (opportunity.metric?.control === "dispositivo") {
        if (!whyDevice) {
          drop(
            `"${title}" (vale igual nas duas telas: não explica por que o ${opportunity.device === "desktop" ? "computador" : "celular"} perde do outro)`,
          );
          continue;
        }
        // A diferença entre as telas tem que estar nos fatos, dos dois lados.
        const contrast = deviceContrast(
          whyDevice,
          x.fatos_contraste ?? x.fatos_dispositivo,
          book,
        );
        if (typeof contrast === "string") {
          drop(`"${title}" (${contrast})`);
          continue;
        }
        tree.por_que_no_dispositivo = whyDevice;
        tree.fatos_contraste = contrast;
      }
      const prediction = text(x.prediction);
      const check = asCheck(x.check);
      const checkNote = text(x.check_note);
      if (!prediction) {
        drop(`"${title}" (sem previsão que os dados possam conferir)`);
        continue;
      }
      if (check === "contradiz") {
        drop(
          `"${title}" (os próprios dados contradizem${checkNote ? `: ${checkNote}` : ""})`,
        );
        continue;
      }
      // Portão em código antes de gastar verificação (triage.ts).
      const gate = triage(
        {
          title,
          tree,
          control: opportunity.metric?.control ?? null,
          elementLabel: tree.alvo?.kind === "element" ? tree.alvo.label : null,
        },
        book,
        drafts.flatMap((d) => {
          const k = d.tree ? triageKey(d.tree) : null;
          return k ? [k] : [];
        }),
      );
      if (gate) {
        drop(`"${title}" (${gate})`);
        continue;
      }
      const benchmark = parseBenchmark(x.benchmark, urlOf);
      const confidence = clamp01(x.confidence);
      const cited = knowledge
        ? resolveCitations(x.fontes_conhecimento, knowledge)
        : [];
      tree.fontes_conhecimento = cited.map((e) => e.id);
      const contrastFacts = (tree.fatos_contraste ?? [])
        .map((fid) => book.get(fid))
        .filter((f): f is UxFact => !!f)
        .map((f) => `\n  - ${factLine(f)}`)
        .join("");
      const evidenceMd = [
        claimsMarkdown(tree, book) || text(x.evidence_md),
        `**Se for isso:** ${prediction}`,
        `**Nestes dados:** ${checkNote || "não há dado pra conferir."}`,
        tree.por_que_no_segmento
          ? `**Por que pesa mais em ${SEGMENT_WORD[opportunity.metric?.segment?.key ?? ""] ?? opportunity.metric?.segment?.key}:** ${tree.por_que_no_segmento}`
          : "",
        tree.por_que_no_dispositivo
          ? `**O que muda entre as telas:** ${tree.por_que_no_dispositivo}${contrastFacts}`
          : "",
        cited.length > 0
          ? `**Por que explicaria (o que já se sabe):**\n${cited.map((e) => `- ${e.stale ? "(vencido: a página mudou desde então) " : ""}${e.conhecimento} (${SOURCE_TYPE_LABEL[e.tipo_fonte]}: ${e.fonte})${e.trecho ? `\n  > "${e.trecho}"` : ""}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      newRank.set(index + 1, drafts.length + 1);
      drafts.push({
        kind: "proposta",
        opportunity_id: opportunity.id,
        rank: drafts.length + 1,
        title,
        device: opportunity.device,
        evidence_md: evidenceMd,
        idea: tree.intervencao ?? "",
        why: tree.mecanismo,
        where: text(x.where) || tree.alvo?.label || "",
        money: null,
        confidence:
          check === "sem_dado"
            ? Math.min(confidence, UNCHECKED_CONFIDENCE)
            : confidence,
        benchmark_refs: benchmark.map((b) => b.domain),
        benchmark,
        before_url: null,
        category: tree.category,
        tree,
      });
      if (drafts.length === MAX_HYPOTHESES_PER_OPPORTUNITY) break;
    }
    for (const d of drafts) {
      if (!d.tree) continue;
      d.tree.relacoes = d.tree.relacoes
        .map((rel) => ({ ...rel, rank: newRank.get(rel.rank) ?? 0 }))
        .filter((rel) => rel.rank > 0 && rel.rank !== d.rank);
    }
    discarded.set(opportunity.id, parseDiscarded(r.categorias_descartadas));
    out.set(opportunity.id, drafts);
  }
  return { byOpportunity: out, dropped, droppedBy, discarded };
}

// ── 3. Revisão contraditória ─────────────────────────────────────────────────

/** Só texto e um modelo mais barato: é conferir número, não olhar print. */
const CHALLENGE_MODEL: LlmTier = "smart";

const CHALLENGE_SYSTEM = `Você revisa hipóteses de CRO com ceticismo. Seu trabalho é tentar DERRUBAR cada hipótese usando só os dados abaixo — não melhorá-la.

Para cada hipótese, procure:
- um dado aqui que contradiz a causa ou a previsão dela (ex.: diz que a grade quebrada derruba a venda, mas os produtos com grade quebrada convertem mais que os outros);
- número que não mede a causa (ex.: clique morto da página inteira usado como prova de um componente; um print de produto esgotado usado pra falar da PDP comum);
- uma explicação mais simples pros mesmos números;
- um A/B desta loja ou um veredito desta loja ("O que já se sabe") que já mostrou o contrário — isso derruba;
- conhecimento geral usado como prova: estudo ou benchmark de fora dizem que PODE acontecer, não que acontece aqui;
- oportunidade de um segmento (canal, nova × recorrente) com uma causa que atinge todo mundo igual: ela não explica por que AQUELE segmento converte menos — isso derruba;
- ganho que vem de "quem usa X converte mais, então mais gente usando X sobe a conversão": quem usa X escolheu usar (viés de seleção). Se é o mecanismo central, isso derruba;
- clique morto num elemento que "leva pra" outra página (link, enviar busca) usado como "não responde": é a página nova demorando, e se quem clica vai mais ao carrinho, o elemento funciona — isso derruba;
- uma causa que não age na perda da oportunidade (outra etapa, outra parte do funil, outro público): é de outro problema — isso derruba.

O TIPO DA PERDA (vem em cada hipótese) decide o que conta contra:
- perda de "dispositivo": uma causa igual nas duas telas não explica a diferença — isso derruba;
- perda "absoluta": não há comparação; "é igual no outro dispositivo" ou "o outro dispositivo converte diferente" NÃO é argumento contra — não derrube por isso;
- perda de "segmento": uma causa que atinge todo mundo igual não explica o segmento — isso derruba.

"verdict":
- "derrubada": algum dado aqui contradiz a hipótese ou a previsão dela, ou o mecanismo central é um dos dois erros de leitura acima.
- "fraca": nada contradiz, mas o número citado não mede a causa, ou há explicação melhor.
- "de_pe": os números medem a causa e nada contradiz.
Falta de dado é "fraca", nunca "derrubada". Não invente dado.

"reason": uma frase, com o número que decide. Português do Brasil, sem jargão.`;

interface ReviewTarget {
  id: string;
  opportunityId: string;
  index: number;
}

/**
 * Tenta derrubar cada hipótese com os próprios dados. Derrubada sai (e vira
 * "limite"); fraca fica com confiança no teto de sem-dado e o motivo junto da
 * evidência. Se a revisão falhar, as hipóteses seguem como estavam e a falha
 * vira limite: a revisão é um filtro, não um passo de que a análise dependa.
 */
async function challengeHypotheses(opts: {
  llm: Llm;
  evidence: DiagnosisEvidence;
  opportunities: UxOpportunity[];
  result: OpportunityHypothesesResult;
  onUsage: (u: LlmUsage) => void;
  /** O mesmo bloco de conhecimento que as hipóteses viram. */
  knowledgeText?: string;
}): Promise<OpportunityHypothesesResult> {
  const { result } = opts;
  const targets: ReviewTarget[] = [];
  const blocks: string[] = [];
  for (const o of opts.opportunities) {
    const drafts = result.byOpportunity.get(o.id) ?? [];
    for (const [index, h] of drafts.entries()) {
      const id = `o${o.rank}-h${index + 1}`;
      targets.push({ id, opportunityId: o.id, index });
      const tree = h.tree;
      const evidenceText = tree ? claimsWithFacts(tree) : h.evidence_md;
      blocks.push(
        `### ${id} — oportunidade: ${o.title}${measuredForPrompt(o.measured, o.reliability)}${o.metric?.control ? `\n- tipo da perda: ${o.metric.control}. ${controlNote(o.metric.control, o.metric.segment?.key)}` : ""}\n- hipótese${tree ? ` (${CATEGORY_WORD[tree.category]})` : ""}: ${tree?.statement ?? h.title}\n- causa: ${h.title}\n- mecanismo: ${h.why}\n- onde: ${h.where}\n- o que fazer: ${h.idea || "nada na página (explicação de fora da página)"}${tree?.por_que_no_dispositivo ? `\n- por que muda entre as telas: ${tree.por_que_no_dispositivo}${tree.fatos_contraste?.length ? ` [${tree.fatos_contraste.join(", ")}]` : ""}` : ""}\n- evidência (o rótulo já foi conferido contra os fatos citados):\n${evidenceText}${tree?.como_refutar ? `\n- como refutar: ${tree.como_refutar}` : ""}`,
      );
    }
  }
  if (targets.length === 0) return result;

  let raw: string;
  try {
    raw = await opts.llm(
      {
        tier: CHALLENGE_MODEL,
        maxTokens: 4_000,
        temperature: 0,
        timeoutMs: 180_000,
        systemPrompt: CHALLENGE_SYSTEM,
        userPrompt: `${factBookForPrompt(factBook(opts.evidence), opts.evidence.gaps)}
${opts.knowledgeText ? `\n${opts.knowledgeText}\n` : ""}
## Hipóteses pra revisar
${blocks.join("\n\n")}

Responda SÓ este JSON:
{ "reviews": [ { "id": "o1-h1", "verdict": "de_pe" | "fraca" | "derrubada", "reason": "..." } ] }`,
      },
      opts.onUsage,
    );
  } catch (err) {
    return {
      ...result,
      dropped: [
        ...result.dropped,
        `A revisão contraditória das hipóteses não rodou: ${err instanceof Error ? err.message : err}`,
      ],
    };
  }
  return applyChallenge(raw, targets, result);
}

/** A favor / contra com os fatos citados, pra quem revisa conferir no livro. */
function claimsWithFacts(tree: HypothesisTree): string {
  const line = (c: UxClaim) =>
    `- ${c.text}${c.facts && c.facts.length > 0 ? ` [${c.facts.join(", ")}]` : ""} (${CLAIM_WORD[c.label]})`;
  return [
    ...tree.a_favor.map((c) => `a favor ${line(c)}`),
    ...tree.contra.map((c) => `contra ${line(c)}`),
  ].join("\n");
}

/** Exportado pra teste. */
export function applyChallenge(
  raw: string,
  targets: ReviewTarget[],
  result: OpportunityHypothesesResult,
): OpportunityHypothesesResult {
  let reviews: Array<Record<string, unknown>> = [];
  try {
    const parsed = parseJson(raw, "revisão");
    reviews = Array.isArray(parsed.reviews)
      ? (parsed.reviews as Array<Record<string, unknown>>)
      : [];
  } catch (err) {
    return {
      ...result,
      dropped: [
        ...result.dropped,
        `A revisão contraditória das hipóteses não rodou: ${err instanceof Error ? err.message : err}`,
      ],
    };
  }
  const verdictOf = new Map(reviews.map((r) => [text(r.id), r]));
  const dropped = [...result.dropped];
  const droppedBy = new Map(
    [...result.droppedBy].map(([k, v]): [string, string[]] => [k, [...v]]),
  );
  const byOpportunity = new Map<string, HypothesisDraft[]>();
  for (const [opportunityId, drafts] of result.byOpportunity) {
    const kept: HypothesisDraft[] = [];
    for (const [index, h] of drafts.entries()) {
      const target = targets.find(
        (t) => t.opportunityId === opportunityId && t.index === index,
      );
      const review = target ? verdictOf.get(target.id) : undefined;
      const verdict = text(review?.verdict).toLowerCase();
      const reason = text(review?.reason);
      if (verdict.startsWith("derrubada")) {
        const why = `"${h.title}" (derrubada na revisão${reason ? `: ${reason}` : ""})`;
        dropped.push(why);
        droppedBy.set(opportunityId, [
          ...(droppedBy.get(opportunityId) ?? []),
          why,
        ]);
        continue;
      }
      if (verdict.startsWith("fraca")) {
        kept.push({
          ...h,
          confidence: Math.min(h.confidence, UNCHECKED_CONFIDENCE),
          evidence_md: `${h.evidence_md}\n\n**Revisão:** ${reason || "o número citado não mede a causa."}`,
        });
        continue;
      }
      kept.push(h);
    }
    byOpportunity.set(opportunityId, renumber(kept));
  }
  // `...result` mantém as categorias descartadas da árvore.
  return { ...result, byOpportunity, dropped, droppedBy };
}

/**
 * Rank 1..n de novo depois que a revisão derruba alguma, e as ligações da
 * árvore ("concorre com H2") seguem o rank novo; a ligação com uma derrubada
 * some.
 */
function renumber(kept: HypothesisDraft[]): HypothesisDraft[] {
  const newRank = new Map(kept.map((h, i) => [h.rank, i + 1]));
  return kept.map((h, i) => ({
    ...h,
    rank: i + 1,
    ...(h.tree
      ? {
          tree: {
            ...h.tree,
            relacoes: h.tree.relacoes
              .map((r) => ({ ...r, rank: newRank.get(r.rank) ?? 0 }))
              .filter((r) => r.rank > 0 && r.rank !== i + 1),
          },
        }
      : {}),
  }));
}

/** `www.loja.com` e `loja.com` são a mesma loja. */
const bareDomain = (d: string) => d.replace(/^www\./, "");

/** Só loja capturada nesta análise; o resto é citação de memória e cai. */
function parseBenchmark(
  v: unknown,
  urlOf: Map<string, string>,
): HypothesisBenchmark[] {
  if (!Array.isArray(v)) return [];
  const out: HypothesisBenchmark[] = [];
  for (const item of v) {
    const b = (item ?? {}) as Record<string, unknown>;
    const normalized = normalizeDomain(text(b.domain));
    const domain = normalized ? bareDomain(normalized) : null;
    const whatTheyDo = text(b.what_they_do);
    if (!domain || !urlOf.has(domain) || !whatTheyDo) continue;
    if (out.some((x) => x.domain === domain)) continue;
    out.push({
      domain,
      url: urlOf.get(domain) ?? null,
      what_they_do: whatTheyDo,
    });
  }
  return out;
}
