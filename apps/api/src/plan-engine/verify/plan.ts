/**
 * Verification plan: the model picks up to 4 tests that decide a hypothesis's CAUSE, writing `confirms_if`/`refutes_if`
 * BEFORE seeing the result, from fixed steps and our targets only. This parses and validates it; browser and repo run it.
 */

import {
  describeElementLabel,
  evidenceForPrompt,
  foldNote,
} from "../hypotheses.ts";
import { parseJson, text } from "../opportunities.ts";
import { pageSpec } from "../page-types.ts";
import type { Llm, LlmTier, LlmUsage } from "../ports.ts";
import type {
  DiagnosisEvidence,
  UxHypothesis,
  UxOpportunity,
  UxPageType,
  UxPart,
} from "../types.ts";
import {
  MAX_CHECKS,
  MAX_STEPS,
  MAX_WAIT_MS,
  type VerifyCheck,
  type VerifyStep,
  type VerifyTarget,
} from "./types.ts";

/** Same as the adversarial review: reasoning over text and numbers. */
export const VERIFY_MODEL: LlmTier = "smart";

export interface PlanContext {
  /** "root|el" keys the capture labeled (element_labels from any capture). */
  elementKeys: Set<string>;
  /** Parts of the analyzed page type. Absent = the PDP's. */
  parts?: ReadonlyArray<UxPart>;
}

export interface ParsedPlan {
  checks: VerifyCheck[];
  dropped: string[];
  untestable: string | null;
}

const partsOf = (t: UxPageType | undefined): UxPart[] =>
  Object.keys(pageSpec(t).parts) as UxPart[];
const TARGET_OPS = [
  "click",
  "scroll_to",
  "inspect",
  "observe_click",
  "screenshot",
];
/** No field besides `op` (anything else the model sends is dropped). */
const BARE_OPS = ["choose_size", "choose_variant", "gesture"];
/** Open the page; the only extra field is the boolean `keep_overlays`. */
const PAGE_OPS = ["open", "reload"];

function parseTarget(raw: unknown, ctx: PlanContext): VerifyTarget | string {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.kind === "part") {
    const name = text(t.part);
    const part = (ctx.parts ?? partsOf("pdp")).find((p) => p === name);
    return part ? { kind: "part", part } : `parte "${name}" não existe`;
  }
  if (t.kind === "element") {
    const key = text(t.key);
    return ctx.elementKeys.has(key)
      ? { kind: "element", key }
      : `elemento "${key}" não está nas capturas`;
  }
  return "alvo sem tipo válido";
}

/**
 * Validates the steps (also for the test the repo asks of the browser). A missing `open` is prepended and counts
 * toward MAX_STEPS: exceeding it rejects the test instead of silently truncating.
 */
export function validateSteps(
  steps: unknown,
  ctx: PlanContext,
): { steps: VerifyStep[] } | { error: string } {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { error: "teste ao vivo sem passos" };
  }
  const out: VerifyStep[] = [];
  for (const [i, raw] of steps.entries()) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const op = text(s.op);
    if (BARE_OPS.includes(op)) {
      out.push({ op } as VerifyStep);
    } else if (PAGE_OPS.includes(op)) {
      out.push(
        (typeof s.keep_overlays === "boolean"
          ? { op, keep_overlays: s.keep_overlays }
          : { op }) as VerifyStep,
      );
    } else if (op === "wait") {
      const ms = Number(s.ms);
      out.push({
        op: "wait",
        ms: Number.isFinite(ms)
          ? Math.min(MAX_WAIT_MS, Math.max(0, ms))
          : MAX_WAIT_MS,
      });
    } else if (TARGET_OPS.includes(op)) {
      const target = parseTarget(s.target, ctx);
      if (typeof target === "string") {
        return { error: `passo ${i + 1} (${op}): ${target}` };
      }
      // The browser never clicks buy: the code answers what the button does.
      if (
        (op === "click" || op === "observe_click") &&
        target.kind === "part" &&
        target.part === "buy_button"
      ) {
        return {
          error: `passo ${i + 1} (${op}): clicar no botão de compra mexeria na loja; pergunte ao código o que ele faz`,
        };
      }
      out.push({ op, target } as VerifyStep);
    } else {
      return { error: `passo ${i + 1}: operação "${op}" não existe` };
    }
  }
  if (out[0]?.op !== "open") out.unshift({ op: "open" });
  if (out.length > MAX_STEPS) {
    return {
      error: `${out.length} passos, o limite é ${MAX_STEPS} (contando a abertura da página)`,
    };
  }
  return { steps: out };
}

/** Exported for tests. Throws if the model did not return JSON. */
export function parsePlan(raw: string, ctx: PlanContext): ParsedPlan {
  const parsed = parseJson(raw, "plano de verificação");
  const list = Array.isArray(parsed.checks)
    ? (parsed.checks as Array<Record<string, unknown>>)
    : [];
  const dropped: string[] = [];
  const valid: Omit<VerifyCheck, "id">[] = [];
  // Validate everything before truncating, so invalid tests do not take slots from valid ones.
  for (const c of list) {
    const claim = text(c.claim) || "(sem descrição)";
    const drop = (why: string) => dropped.push(`"${claim}": ${why}`);
    const stage = text(c.stage);
    if (stage !== "live" && stage !== "repo") {
      drop(`etapa "${stage}" não existe`);
      continue;
    }
    const confirms_if = text(c.confirms_if);
    const refutes_if = text(c.refutes_if);
    if (!confirms_if || !refutes_if) {
      drop("sem o que confirma e o que desmente");
      continue;
    }
    const device = text(c.device) === "desktop" ? "desktop" : "mobile";
    const base = { claim, stage, device, confirms_if, refutes_if } as const;
    if (stage === "repo") {
      const question = text(c.question);
      if (!question) {
        drop("teste de repo sem pergunta");
        continue;
      }
      valid.push({
        ...base,
        steps: [],
        question,
      });
      continue;
    }
    const v = validateSteps(c.steps, ctx);
    if ("error" in v) {
      drop(v.error);
      continue;
    }
    valid.push({
      ...base,
      steps: v.steps,
      question: null,
    });
  }
  if (valid.length > MAX_CHECKS) {
    dropped.push(
      `${valid.length - MAX_CHECKS} teste(s) válido(s) além do limite de ${MAX_CHECKS}`,
    );
  }
  const checks: VerifyCheck[] = valid
    .slice(0, MAX_CHECKS)
    .map((c, i) => ({ ...c, id: `c${i + 1}` }));
  return {
    checks,
    dropped,
    untestable: checks.length === 0 ? text(parsed.untestable) || null : null,
  };
}

function elementKeysOf(evidence: DiagnosisEvidence): Set<string> {
  const keys = new Set<string>();
  for (const c of evidence.captures) {
    for (const k of Object.keys(c.element_labels ?? {})) keys.add(k);
  }
  return keys;
}

/** The plan prompt for this page type (parts and name vary). */
function planSystem(pageType: UxPageType = "pdp"): string {
  const spec = pageSpec(pageType);
  const name = spec.key === "pdp" ? "PDP" : spec.label.toLowerCase();
  const where = spec.key === "pdp" ? "numa PDP" : `na página de ${name}`;
  const pageReal =
    spec.key === "pdp" ? "a nossa PDP real" : `a nossa página de ${name} real`;
  const parts = partsOf(pageType).join("|");
  return `Você planeja a VERIFICAÇÃO de uma hipótese de CRO ${where}. A hipótese afirma uma CAUSA; cada teste seu precisa decidir essa causa, não só mostrar algo parecido.

Escreva "confirms_if" e "refutes_if" de cada teste ANTES de imaginar o resultado: o que, observado, confirma a causa e o que a desmente. Um sem o outro não vale.

Tipos de teste ("stage"):
- "live": abre ${pageReal} num navegador e executa passos. Só use estes passos: open, click, choose_size, choose_variant, reload, scroll_to, wait (ms até 8000; pop-up que abre com atraso pede uma espera maior), gesture, inspect, observe_click, screenshot.
  - click, scroll_to, inspect, observe_click e screenshot levam "target".
  - "inspect" lê estilo e tamanho do alvo; "observe_click" clica e conta o que mudou na página.
  - A página abre com pop-up, modal e banner de cookie FECHADOS. Pra testar um pop-up/modal/banner que cobre a página, use {"op":"open","keep_overlays":true} (e no "reload", se houver); fora isso, não use.
  - Pop-up/banner pode só abrir no primeiro gesto da pessoa (mexer o mouse ou o dedo), e o navegador do teste não mexe sozinho. Pra testar, use {"op":"open","keep_overlays":true}, {"op":"gesture"} (mexe o mouse no meio da tela, sem clicar nem tocar) e depois {"op":"wait","ms":8000}, antes de olhar o pop-up.
  - Alvo é SEMPRE um destes: {"kind":"element","key":"<chave da lista de elementos>"} ou {"kind":"part","part":"${parts}"}. Nada de seletor CSS nem código.
  - Nunca clique em comprar, sacola, finalizar compra, login ou formulário: isso mexe na loja. O que o botão de compra faz (abre tamanho, rola, vai pro carrinho), pergunte ao código ("repo"), não clique.
- "repo": uma pergunta sobre o código da loja, pra quando a causa está em estados que mudam aparência ou comportamento (sem estoque, carregando, erro, tamanho escolhido). Leva "question".

Regras:
- No máximo ${MAX_CHECKS} testes, no máximo ${MAX_STEPS} passos cada. Menos é melhor: só o que decide.
- Se nada aqui dá pra testar numa página (ex.: preferência da cliente), devolva "checks": [] e diga em "untestable" por quê.
- Teste a causa como a hipótese afirma, não uma versão mais forte: nada de "só isso explica", "sempre", "em toda página". Se a hipótese diz "a vitrine fica no fundo", o teste decide se ela fica no fundo, não se a posição é a única explicação.
- Critério de posição: dobra e alcance são coisas diferentes, e o teste usa a régua que a hipótese usa.
  - "abaixo da dobra", "fora da primeira tela": compare a posição em px com a ALTURA DA TELA do aparelho (a dobra, nos alvos abaixo); alcance não entra. Ex.: "confirma se o botão de compra está em y maior que 844px, a altura da tela do celular".
  - "no fundo da página", "quase ninguém chega lá": aí sim, % da página comparado com o alcance medido. Ex.: "confirma se a vitrine está abaixo do ponto que menos da metade das pessoas alcança". Os dados de rolagem e a altura da página estão acima.
  - Nunca um número de px solto, sem dizer contra o quê.
- Português do Brasil, frases curtas.`;
}

export const PLAN_SYSTEM = planSystem("pdp");

function targetsForPrompt(evidence: DiagnosisEvidence): string {
  const lines: string[] = [];
  for (const c of evidence.captures) {
    lines.push(`### ${c.device} (${c.viewport.width}×${c.viewport.height})`);
    lines.push("Partes (part) e onde estão:");
    for (const p of partsOf(evidence.page_type)) {
      const y = c.positions[p] ?? null;
      lines.push(`- ${p}: ${foldNote(y, c.viewport.height)}`);
    }
    const labels = Object.entries(c.element_labels ?? {});
    if (labels.length > 0) {
      lines.push("Elementos (key → o que é, pra onde leva, y em px):");
      for (const [key, l] of labels) {
        lines.push(`- ${key} → ${describeElementLabel(l)}`);
      }
    }
  }
  return lines.join("\n");
}

/** Asks the model for the plan. Network/JSON failures propagate to the caller. */
export async function planVerification(opts: {
  llm: Llm;
  hypothesis: UxHypothesis;
  opportunity: UxOpportunity;
  evidence: DiagnosisEvidence;
  onUsage: (u: LlmUsage) => void;
}): Promise<ParsedPlan> {
  const { hypothesis: h, opportunity: o, evidence } = opts;
  const raw = await opts.llm(
    {
      tier: VERIFY_MODEL,
      maxTokens: 3_000,
      temperature: 0,
      timeoutMs: 120_000,
      systemPrompt: planSystem(evidence.page_type),
      userPrompt: `${evidenceForPrompt(evidence)}

## Alvos que você pode usar nos passos
${targetsForPrompt(evidence)}

## Hipótese pra verificar (oportunidade: ${o.title})
- título: ${h.title}
- aparelho: ${h.device}
- por quê (a causa): ${h.why}
- onde: ${h.where}
- o que fazer: ${h.idea}
- evidência:
${h.evidence_md}

Responda SÓ este JSON:
{ "checks": [ { "claim": "o que este teste verifica", "stage": "live" | "repo", "device": "mobile" | "desktop", "steps": [ { "op": "open" } ], "question": "só em repo", "confirms_if": "...", "refutes_if": "..." } ], "untestable": "só se checks for vazio: por quê" }`,
    },
    opts.onUsage,
  );
  return parsePlan(raw, {
    elementKeys: elementKeysOf(evidence),
    parts: partsOf(evidence.page_type),
  });
}
