/**
 * Sondas: o que a página FAZ, medido antes de qualquer hipótese.
 *
 * Até 19/11 a hipótese imaginava o comportamento e só a verificação, depois,
 * conferia. Na PDP de uma loja de moda (16/11) "o 'comprar' sobre a foto barra
 * quem não escolheu tamanho" e "as setas da galeria não respondem" eram
 * palpites, e os dois foram desmentidos (o botão abre uma gaveta; no celular
 * não há seta). É a lição do ARTEMIS: reproduzir antes de afirmar.
 *
 * Duas sondas, em código, sem modelo:
 * - **camadas**: abre a página SEM fechar pop-up, mexe o mouse (o pop-up de
 *   uma loja só abre no primeiro movimento) e mede cada camada fixa sobre a
 *   1ª tela e se ela cobre o preço e o botão de compra. A captura de sempre
 *   fecha tudo antes de medir, então isto nunca tinha virado fato;
 * - **toque**: nos elementos com muito clique morto (que não trocam de página
 *   nem estão escondidos), clica e diz o que mudou, pelo mesmo caminho do
 *   verificador (rastreio bloqueado, sacola/checkout/login proibidos).
 *
 * O resultado vai pra evidência (`evidence.probes`) e vira fato "interação"
 * (facts.ts). Sonda que falha vira resultado com o motivo, nunca erro.
 */

import { describeElementLabel } from "./hypotheses.ts";
import type { OverlaysReading } from "./page-scripts.ts";
import type { DiagnosisEvidence, PageCapture, UxDevice } from "./types.ts";

export type ProbeResult =
  | {
      kind: "camadas";
      device: UxDevice;
      url: string;
      ok: true;
      reading: OverlaysReading;
      /** Print da 1ª tela com as camadas abertas. */
      screenshot_url: string | null;
    }
  | {
      kind: "toque";
      device: UxDevice;
      url: string;
      ok: true;
      /** `root|el` da Deco Analytics. */
      key: string;
      label: string;
      /** O que mudou depois do clique, ou por que não clicou. */
      observed: string;
      /** false = não clicou (proibido, escondido, coberto, não achou). */
      clicked: boolean;
    }
  | {
      kind: "camadas" | "toque";
      device: UxDevice;
      url: string;
      ok: false;
      error: string;
      key?: string;
      label?: string;
    };

/** Elementos tocados por dispositivo (cada um abre a página de novo). */
export const MAX_TOUCH_PROBES = 2;
/** A partir disto de clique morto em elemento clicável, vale tocar. */
const DEAD_SHARE = 0.3;
const MIN_CLICKS = 200;

/** A captura de cada tela que mostra a página de sempre (não a de falta). */
export function primaryCaptures(evidence: DiagnosisEvidence): PageCapture[] {
  const out: PageCapture[] = [];
  for (const device of ["mobile", "desktop"] as const) {
    const c =
      evidence.captures.find(
        (x) =>
          x.device === device &&
          x.stock !== "sold_out" &&
          x.stock !== "broken_grid",
      ) ?? evidence.captures.find((x) => x.device === device);
    if (c?.viewport) out.push(c);
  }
  return out;
}

/**
 * Os elementos a tocar numa tela: muito clique morto em elemento clicável,
 * achado na captura, que não troca de página nem está escondido. Os de mais
 * cliques mortos primeiro. Exportado pra teste.
 */
export function touchTargets(
  evidence: DiagnosisEvidence,
  capture: PageCapture,
): Array<{ key: string; label: string }> {
  const b = evidence.pdp_behaviour.find((x) => x.device === capture.device);
  const labels = capture.element_labels ?? {};
  return (b?.elements ?? [])
    .filter(
      (e) =>
        e.clicks >= MIN_CLICKS && e.dead_interactive / e.clicks >= DEAD_SHARE,
    )
    .map((e) => ({
      e,
      key: `${e.root}|${e.el}`,
      l: labels[`${e.root}|${e.el}`],
    }))
    .filter(({ l }) => l && !l.navigates && !l.hidden)
    .sort((a, b) => b.e.dead_interactive - a.e.dead_interactive)
    .slice(0, MAX_TOUCH_PROBES)
    .map(({ key, l }) => ({ key, label: l ? describeElementLabel(l) : key }));
}
