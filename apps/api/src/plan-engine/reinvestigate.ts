/**
 * Feeds verification back to the investigator: what verification saw becomes a
 * citable fact (`verificacao`), and causes already tried enter as "tried and
 * fell" with the reason, so a new round for the SAME loss does not repeat them.
 */

import type { UxFact } from "./facts.ts";
import type { UxHypothesis } from "./types.ts";

const GROUP =
  "Verificações desta análise: o que se testou na página e no código das causas que caíram";

/** An opportunity's refuted hypotheses → facts for the next round. */
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
      // The judge is a model reading the tests: a reading, not a measurement.
      measured: false,
      group: GROUP,
      text: `a verificação desmentiu "${h.title}": ${v.summary}${lines.length > 0 ? ` (linhas abertas: ${lines.join("; ")})` : ""}`,
    });
  }
  return out;
}

/** What was already tried for this opportunity, one line per cause with why it fell. `extra` holds fall reasons not stored on a hypothesis. */
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
