/**
 * Veredito da verificação. O modelo compara o que o navegador viu (`observed`)
 * com o `confirms_if`/`refutes_if` de cada teste e sugere um veredito geral;
 * quem decide de verdade é o código (`parseJudgment`): o modelo já disse
 * "confirmada" com um teste que desmentia, então a palavra final nunca é dele.
 */

import { parseJson, text } from "../opportunities.ts";
import type { Llm, LlmUsage } from "../ports.ts";
import type { UxHypothesis } from "../types.ts";
import { VERIFY_MODEL } from "./plan.ts";
import type { CheckOutcome, CheckRun, Verdict } from "./types.ts";

export interface RewriteDraft {
  title: string;
  why: string;
  prediction: string;
  evidence_md: string;
  idea: string;
  where: string;
}

export interface JudgeResult {
  verdict: Verdict;
  summary: string;
  runs: CheckRun[];
  rewrite: RewriteDraft | null;
  /** Só com o veredito desmentida (ou reescrita): o que investigar agora. */
  novas_linhas?: string[];
}

/** Confirmada: confidence = min(CONFIRM_CEILING, confidence + CONFIRM_BOOST). */
export const CONFIRM_BOOST = 0.2;
export const CONFIRM_CEILING = 0.9;

const JUDGED: readonly string[] = ["confirma", "desmente", "nao_decidiu"];
const REWRITE_FIELDS = [
  "title",
  "why",
  "prediction",
  "evidence_md",
  "idea",
  "where",
] as const;

function parseRewrite(raw: unknown): RewriteDraft | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out = {} as RewriteDraft;
  for (const f of REWRITE_FIELDS) {
    const v = text(r[f]);
    if (!v) return null;
    out[f] = v;
  }
  return out;
}

const inconclusive = (why: string, runs: CheckRun[]): JudgeResult => ({
  verdict: "inconclusiva",
  summary: `a verificação não decidiu: ${why}`,
  runs,
  rewrite: null,
});

/** Resumo montado no código quando o modelo não escreveu um: cita o teste que decidiu. */
function summaryFrom(run: CheckRun, verdict: Verdict): string {
  const what = run.outcome === "desmente" ? "desmentida" : "confirmada";
  const base = `${what === "desmentida" ? "Desmentida" : "Confirmada"} pelo teste ${run.check.id} ("${run.check.claim}")`;
  return verdict === "reescrita" ? `${base}; reescrita proposta` : base;
}

/**
 * Exportado pra teste. Nunca lança: saída ilegível vira `inconclusiva` com os
 * runs como vieram. As regras valem nesta ordem e o modelo só opina nos testes
 * `nao_decidiu` (um `nao_testou` ou um run de repo já decidido não muda).
 */
export function parseJudgment(
  raw: string,
  runs: CheckRun[],
  allowRewrite: boolean,
): JudgeResult {
  const out = judge(raw, runs, allowRewrite);
  return out.verdict === "desmentida" || out.verdict === "reescrita"
    ? out
    : { ...out, novas_linhas: undefined };
}

function judge(
  raw: string,
  runs: CheckRun[],
  allowRewrite: boolean,
): JudgeResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJson(raw, "veredito");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("o modelo não devolveu um objeto de veredito");
    }
  } catch (err) {
    return inconclusive(err instanceof Error ? err.message : String(err), runs);
  }
  const byId = new Map<string, CheckOutcome>();
  // Teste que não mede a causa (mede o sintoma) sai dos DOIS lados da conta.
  const offCause = new Set<string>();
  if (Array.isArray(parsed.runs)) {
    for (const r of parsed.runs as Array<Record<string, unknown>>) {
      const o = text(r?.outcome);
      if (JUDGED.includes(o)) byId.set(text(r?.id), o as CheckOutcome);
      if (r?.measures_cause === false) offCause.add(text(r?.id));
    }
  }
  const judged = runs.map((r) => {
    const o = byId.get(r.check.id);
    const run = r.outcome === "nao_decidiu" && o ? { ...r, outcome: o } : r;
    // Guarda o "não mede a causa": os níveis de validação também o pulam.
    return offCause.has(r.check.id) ? { ...run, measures_cause: false } : run;
  });
  const novasLinhas = (
    Array.isArray(parsed.novas_linhas) ? parsed.novas_linhas : []
  )
    .map((l) => text(l))
    .filter(Boolean)
    .slice(0, 3);
  // Sem isto, um teste do sintoma contra um que desmente a causa virava conflito.
  const counted = judged.filter((r) => !offCause.has(r.check.id));
  const desmente = counted.find((r) => r.outcome === "desmente");
  const confirma = counted.find((r) => r.outcome === "confirma");
  const set = (ids: string[]) => ids.join(", ");
  const discarded = judged
    .filter(
      (r) =>
        offCause.has(r.check.id) &&
        (r.outcome === "confirma" || r.outcome === "desmente"),
    )
    .map((r) => r.check.id);
  const offNote =
    discarded.length > 0
      ? ` (não contam, medem outra coisa que não a causa: ${set(discarded)})`
      : "";
  const modelVerdict = text(parsed.verdict);
  // O resumo do modelo só vale se o veredito final for o que ele disse.
  const summaryIf = (final: Verdict) =>
    modelVerdict === final ? text(parsed.summary) : "";
  if (!desmente && !confirma) {
    return {
      verdict: "inconclusiva",
      summary:
        (summaryIf("inconclusiva") ||
          "Nenhum teste decidiu a causa: a hipótese segue como estava.") +
        offNote,
      runs: judged,
      rewrite: null,
    };
  }
  // Um que confirma e um que desmente é conflito, não derrota.
  if (desmente && confirma) {
    return {
      verdict: "inconclusiva",
      summary: `Testes em conflito: ${confirma.check.id} confirma ("${confirma.check.claim}") e ${desmente.check.id} desmente ("${desmente.check.claim}"). A hipótese segue como estava.${offNote}`,
      runs: judged,
      rewrite: null,
    };
  }
  if (desmente) {
    const rewrite =
      allowRewrite && modelVerdict === "reescrita"
        ? parseRewrite(parsed.rewrite)
        : null;
    const verdict: Verdict = rewrite ? "reescrita" : "desmentida";
    return {
      verdict,
      summary: (summaryIf(verdict) || summaryFrom(desmente, verdict)) + offNote,
      runs: judged,
      rewrite,
      novas_linhas: novasLinhas,
    };
  }
  return {
    verdict: "confirmada",
    summary:
      (summaryIf("confirmada") ||
        summaryFrom(confirma as CheckRun, "confirmada")) + offNote,
    runs: judged,
    rewrite: null,
  };
}

export const JUDGE_SYSTEM = `Você dá o VEREDITO de uma verificação de hipótese de CRO numa página da loja (PDP, home, categoria ou busca). Cada teste tem "confirms_if" e "refutes_if" escritos ANTES do resultado. Compare o que foi observado com eles, sem relaxar o critério.

Em "runs", para TODO teste, diga também "measures_cause": false quando ele não mede a causa da hipótese (mede o sintoma da oportunidade, outra parte da página, ou uma versão diferente da causa); omita ou true quando mede. Teste que não mede a causa não conta pra confirmar nem pra desmentir.

Para cada teste com resultado "nao_decidiu", responda "confirma" (o observado cumpre confirms_if), "desmente" (cumpre refutes_if) ou "nao_decidiu" (não dá pra afirmar nenhum dos dois). Na dúvida, "nao_decidiu". Não mexa nos outros testes.

Veredito geral: "confirmada" (a causa se sustenta), "desmentida" (a causa não se sustenta), "reescrita" (a causa estava errada mas a observação mostra outra causa clara) ou "inconclusiva". Só "reescrita" com todos os campos preenchidos em "rewrite" (title, why, prediction, evidence_md, idea, where); "prediction" é algo conferível numa próxima rodada.

"summary": uma linha em português do Brasil que cita o teste que decidiu (id e o que verificava).

"novas_linhas": se a causa não se sustenta, de 1 a 3 linhas de investigação que a prova abre (ex.: "o botão está visível e funciona: olhar o que acontece depois do clique — o carrinho atualiza? a variante é fácil de escolher?"). Senão, lista vazia.

Um teste que desmente só vale se ele mede a CAUSA da hipótese. Se ele testava uma versão mais forte ("só isso explica", "sempre", "em toda página") ou uma condição que PODE acontecer ("se a lista vier vazia, some"), e outro teste mostrou a causa acontecendo, responda "nao_decidiu" pra ele. O que o navegador viu na página vale mais que uma inferência do código sobre o mesmo fato.

Posição tem duas réguas, e cada teste usa a da hipótese:
- "abaixo da dobra", "fora da primeira tela": compare a posição em px com a ALTURA DA TELA do aparelho (nos "Dados de rolagem" abaixo); alcance não entra. Ex.: botão em y=912 com tela de 844px está abaixo da dobra.
- "no fundo da página", "quase ninguém chega lá": posição em px ÷ altura da página = % da página, e compare com quem chega a 25%/50%/75%. Ex.: vitrine em 50% da página, que só 29% alcançam, fica onde menos da metade chega.
Um teste de alcance não decide uma hipótese de dobra, nem o contrário: responda "nao_decidiu" pra ele. Não invente número que não está aqui.`;

function runsForPrompt(runs: CheckRun[]): string {
  return runs
    .map(
      (r) =>
        `### ${r.check.id} (${r.check.stage}, ${r.check.device}): ${r.check.claim}
- confirms_if: ${r.check.confirms_if}
- refutes_if: ${r.check.refutes_if}
- resultado: ${r.outcome}${r.source_ref ? ` (código: ${r.source_ref})` : ""}
- observado: ${r.observed || "(nada)"}`,
    )
    .join("\n\n");
}

/** Pede o veredito ao modelo. Falha de rede sobe pro chamador; JSON ruim vira inconclusiva. */
export async function judgeVerification(opts: {
  llm: Llm;
  hypothesis: UxHypothesis;
  runs: CheckRun[];
  allowRewrite: boolean;
  /** Rolagem e altura da página medidas no diagnóstico (ver scrollForPrompt). */
  scroll?: string;
  onUsage: (u: LlmUsage) => void;
}): Promise<JudgeResult> {
  const h = opts.hypothesis;
  const raw = await opts.llm(
    {
      tier: VERIFY_MODEL,
      maxTokens: 2_000,
      temperature: 0,
      timeoutMs: 120_000,
      systemPrompt: JUDGE_SYSTEM,
      userPrompt: `## Hipótese
- título: ${h.title}
- por quê (a causa): ${h.why}
- onde: ${h.where}
- o que fazer: ${h.idea}

## Testes e o que se viu
${runsForPrompt(opts.runs)}
${opts.scroll ? `\n## Dados de rolagem do diagnóstico\n${opts.scroll}\n` : ""}
${opts.allowRewrite ? "" : 'Reescrita não é permitida desta vez: não use "reescrita".\n\n'}Responda SÓ este JSON:
{ "verdict": "confirmada" | "desmentida" | "reescrita" | "inconclusiva", "summary": "...", "runs": [ { "id": "c1", "outcome": "confirma" | "desmente" | "nao_decidiu", "measures_cause": true | false } ], "rewrite": { "title": "", "why": "", "prediction": "", "evidence_md": "", "idea": "", "where": "" } | null, "novas_linhas": [] }`,
    },
    opts.onUsage,
  );
  return parseJudgment(raw, opts.runs, opts.allowRewrite);
}

/**
 * Rolagem por dispositivo (Deco Analytics) e altura da página capturada, pro
 * juiz e o plano traduzirem "y=2353" em "50% da página, que só 29% alcançam".
 * Em 14/11 o plano escreveu "confirma se a vitrine estiver abaixo de 3500px",
 * um número solto, e a vitrine em y=2353 (50% da página) ficou "não decidiu"
 * com o dado que decidia (29% chegam a 50%) na mão do diagnóstico.
 */
export function scrollForPrompt(evidence: {
  pdp_behaviour: Array<{
    device: string;
    avg_fold_pct: number;
    avg_depth_pct: number;
    reach: { p25: number; p50: number; p75: number };
  }>;
  captures: Array<{
    device: string;
    page_height: number;
    viewport?: { width: number; height: number };
  }>;
}): string {
  const lines: string[] = [];
  for (const b of evidence.pdp_behaviour) {
    const c = evidence.captures.find((x) => x.device === b.device);
    const height = c?.page_height;
    // A altura da tela é a dobra: "abaixo da dobra" se decide com ela, não com o alcance.
    const screen = c?.viewport?.height;
    lines.push(
      `- ${b.device}: chegam a 25%/50%/75% da página: ${b.reach.p25}% / ${b.reach.p50}% / ${b.reach.p75}%; rolagem média ${b.avg_depth_pct}%; a 1ª tela mostra ${b.avg_fold_pct}% da página${height ? `; altura da página capturada: ${height}px` : ""}${screen ? `; altura da tela (a dobra): ${screen}px` : ""}`,
    );
  }
  // Sem rolagem do aparelho, a altura da tela de toda captura ainda decide a dobra.
  for (const c of evidence.captures) {
    if (evidence.pdp_behaviour.some((b) => b.device === c.device)) continue;
    if (!c.viewport?.height) continue;
    lines.push(
      `- ${c.device}: sem dados de rolagem; altura da tela (a dobra): ${c.viewport.height}px${c.page_height ? `; altura da página capturada: ${c.page_height}px` : ""}`,
    );
  }
  return lines.join("\n");
}
