/**
 * A volta da verificação pro investigador (o laço do ARTEMIS: o que a triagem
 * reprova volta pro supervisor COM o motivo). Até 19/11, quando todas as
 * hipóteses de uma oportunidade caíam na verificação, a oportunidade saía e a
 * reserva (outra perda) tentava o lugar. A perda continuava ali, sem causa, e
 * o que a verificação viu (o botão abre uma gaveta; não existe seta no
 * celular) se perdia.
 *
 * Agora, antes de trocar de oportunidade, uma rodada nova pra MESMA perda:
 * - o que a verificação viu vira fato (`verificacao`), citável como qualquer
 *   outro — a próxima hipótese pode apoiar ou se desviar dele;
 * - as causas já tentadas entram como "já tentado e caiu", com o motivo, pra
 *   não voltarem reescritas.
 */

import type { UxFact } from "./facts.ts";
import type { UxHypothesis } from "./types.ts";

const GROUP =
  "Verificações desta análise: o que se testou na página e no código das causas que caíram";

/** As desmentidas de uma oportunidade → fatos pra próxima rodada. */
export function verdictFacts(
  hypotheses: UxHypothesis[],
): Array<Omit<UxFact, "id">> {
  const out: Array<Omit<UxFact, "id">> = [];
  for (const h of hypotheses) {
    const v = h.verification;
    if (h.kind !== "proposta" || v?.verdict !== "desmentida") continue;
    const lines = (v.novas_linhas ?? []).filter(Boolean);
    out.push({
      kind: "verificacao",
      source: "pagina",
      device: h.device === "mobile" || h.device === "desktop" ? h.device : null,
      // O juiz é um modelo lendo os testes: é leitura, não medida.
      measured: false,
      group: GROUP,
      text: `a verificação desmentiu "${h.title}": ${v.summary}${lines.length > 0 ? ` (linhas abertas: ${lines.join("; ")})` : ""}`,
    });
  }
  return out;
}

/**
 * O que já se tentou pra esta oportunidade, uma linha por causa, com o motivo
 * de ter caído. `extra` são motivos de queda que não ficaram gravados numa
 * hipótese (a triagem e a revisão derrubam antes de gravar).
 */
export function triedLines(
  hypotheses: UxHypothesis[],
  extra: string[] = [],
): string[] {
  const out: string[] = [];
  for (const h of hypotheses) {
    if (h.kind !== "proposta") continue;
    const v = h.verification;
    const why =
      v?.verdict === "desmentida"
        ? `desmentida: ${v.summary}`
        : v?.verdict === "inconclusiva"
          ? `inconclusiva: ${v.summary}`
          : null;
    if (why) out.push(`"${h.title}" — ${why}`);
  }
  for (const e of extra) if (e && !out.includes(e)) out.push(e);
  return out;
}
