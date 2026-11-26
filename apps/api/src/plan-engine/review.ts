/**
 * The independent reviewer: reads ONLY the dossier and answers whether the
 * evidence shows the hypothesis explains the conversion gap. The code applies
 * it only downward: "nao" demotes the hypothesis, "parcial" cuts test priority
 * 20%, "sim" changes nothing. A failed review is shown as a limitation.
 */

import { HYPOTHESES_MODEL } from "./hypotheses.ts";
import { parseJson, text } from "./opportunities.ts";
import type { Llm, LlmUsage } from "./ports.ts";

export interface HypothesisReview {
  explica_o_gap: "sim" | "parcial" | "nao";
  resposta: string;
  falhas: string[];
  reviewed_at: string;
}

export const PARTIAL_FACTOR = 0.8;

export const REVIEW_SYSTEM = `Você é revisor independente de CRO. Recebe dossiês de hipóteses que o sistema considera prontas pra um teste A/B. Você NÃO escreveu essas hipóteses e não deve defendê-las.

Para cada dossiê, responda a pergunta: que evidência mostra que esta causa EXPLICA a perda de conversão da oportunidade — e não só que o componente existe, é diferente, ou que outras lojas fazem diferente?

Procure:
- confirmação de condição tratada como prova de causa ("o botão está abaixo da dobra" não mostra que isso derruba a venda);
- benchmark ou estudo de fora usado como prova do que acontece nesta loja;
- número que mede outra coisa (a página inteira, outro dispositivo, o sintoma da oportunidade);
- evidência contrária no próprio dossiê que não foi levada em conta;
- uma explicação mais simples que o dossiê ignora;
- uma causa que não age na perda do "Problema relacionado" (outra etapa, outro público): a resposta é "nao";
- "quem usa/clica em X converte mais" como prova de que mostrar mais X sobe a conversão: quem usa escolheu usar. Se a causa depende só disso, a resposta é "nao".

O "Tipo da perda" do problema decide o que é falha: numa perda "absoluta" não há comparação entre telas, e "é igual no outro dispositivo" NÃO é falha; numa perda de "dispositivo", uma causa igual nas duas telas não explica a diferença.

"explica_o_gap":
- "sim": há dado DESTA loja ligando a causa à perda (ex.: quem chega ao seletor converte mais; o gap aparece só onde a condição existe);
- "parcial": a condição é real e relevante, mas a ligação com a perda é só plausível;
- "nao": o dossiê só mostra que a condição existe, ou a evidência contrária pesa mais.
Na dúvida entre dois, escolha o mais baixo. "parcial" é a resposta normal pra hipótese bem montada sem A/B; "sim" é raro.

"resposta": uma ou duas frases com o que decide. "falhas": até 3, curtas. Português do Brasil, sem jargão.`;

const ANSWERS = ["sim", "parcial", "nao"] as const;

/** The model's answer as reviews by id. Exported for tests. Never throws. */
export function parseReviews(
  raw: string,
  ids: string[],
  now: string,
): Map<string, HypothesisReview> {
  const out = new Map<string, HypothesisReview>();
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJson(raw, "revisão independente");
  } catch {
    return out;
  }
  for (const item of Array.isArray(parsed.reviews) ? parsed.reviews : []) {
    const r = (item ?? {}) as Record<string, unknown>;
    const id = text(r.id);
    if (!ids.includes(id)) continue;
    const answer = text(r.explica_o_gap)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    const explica = ANSWERS.find((a) => a === answer);
    if (!explica) continue;
    out.set(id, {
      explica_o_gap: explica,
      resposta: text(r.resposta),
      falhas: (Array.isArray(r.falhas) ? r.falhas : [])
        .map((f) => text(f))
        .filter(Boolean)
        .slice(0, 3),
      reviewed_at: now,
    });
  }
  return out;
}

export async function reviewDossiers(opts: {
  llm: Llm;
  dossiers: Array<{ id: string; markdown: string }>;
  onUsage: (u: LlmUsage) => void;
  now: string;
}): Promise<Map<string, HypothesisReview>> {
  if (opts.dossiers.length === 0) return new Map();
  const raw = await opts.llm(
    {
      tier: HYPOTHESES_MODEL,
      maxTokens: 3_000,
      temperature: 0,
      timeoutMs: 180_000,
      systemPrompt: REVIEW_SYSTEM,
      userPrompt: `${opts.dossiers.map((d) => `=== ${d.id} ===\n${d.markdown}`).join("\n\n")}

Responda SÓ este JSON:
{ "reviews": [ { "id": "...", "explica_o_gap": "sim" | "parcial" | "nao", "resposta": "...", "falhas": ["..."] } ] }`,
    },
    opts.onUsage,
  );
  return parseReviews(
    raw,
    opts.dossiers.map((d) => d.id),
    opts.now,
  );
}
