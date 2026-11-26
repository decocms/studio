/**
 * From evidence to hypotheses. The prompt carries the METHOD of the reports,
 * not an answer key. The model does NOT decide the arithmetic (money.ts
 * recomputes it) or the order (rank = value x confidence, computed here); a
 * hypothesis without a number in the evidence or without a valid calculation
 * is dropped and shows up as a "limit" on screen.
 */

import type {
  DevicePdpBehaviour,
  DiagnosisEvidence,
  ElementLabel,
  PageCapture,
} from "./types.ts";

/** The screenshot product's stock, in words; without it the model treats a broken size grid as a normal PDP. */
export function stockNote(stock: PageCapture["stock"]): string {
  switch (stock) {
    case "alive":
      return " — produto à venda";
    case "broken_grid":
      return " — GRADE QUEBRADA: a maioria dos tamanhos esgotou; esta página mostra o estado de falta, não a PDP de sempre";
    case "sold_out":
      return " — ESGOTADO: esta página mostra o estado de falta, não a PDP de sempre";
    default:
      return "";
  }
}

/** One line per heatmap element, labeled by the same device's capture; without a label, say so rather than invent a name. */
export function elementsForPrompt(
  ev: DiagnosisEvidence,
  b: DevicePdpBehaviour,
): string[] {
  const labels = ev.captures.find(
    (c) => c.device === b.device && c.element_labels,
  )?.element_labels;
  const pct = (a: number, total: number) =>
    total > 0 ? `${((a / total) * 100).toFixed(1)}%` : "—";
  const pageCart =
    b.funnel && b.funnel.visitors > 0
      ? b.funnel.carted / b.funnel.visitors
      : null;
  return (b.elements ?? []).map((e) => {
    const l = labels?.[`${e.root}|${e.el}`];
    const what = l
      ? `${describeElementLabel(l)} (${e.section})`
      : `${e.section}: elemento não achado na página capturada`;
    const cart =
      e.funnel && e.funnel.visitors > 0
        ? `${pct(e.funnel.carted, e.funnel.visitors)} foi ao carrinho${pageCart !== null ? ` (página: ${(pageCart * 100).toFixed(1)}%)` : ""}`
        : "sem funil";
    // Dead on a page-navigating element means the new page took over 1 s, not a broken button.
    const dead = `mortos ${pct(e.dead_interactive, e.clicks)}${l?.navigates && e.dead_interactive > 0 ? " (troca de página: morto aqui é a página nova demorando > 1 s, não falha)" : ""}`;
    return `${what} · ${e.clicks} cliques · ${dead} · ${cart}`;
  });
}

/** An element's label as the prompt reads it: what it is, where it leads, where it is; a load-hidden element's y is 0, so "escondido na carga" replaces it. */
export function describeElementLabel(l: ElementLabel): string {
  const to = l.navigates ? ` → leva pra ${l.navigates}` : "";
  const where = l.hidden
    ? "escondido na carga: só aparece depois de abrir outra coisa"
    : `y=${l.y}px`;
  return `${l.label}${to} (${where})`;
}

/** A part's position against the screen height: "699px (na 1ª tela, que vai até 844px)". Exported for tests. */
export function foldNote(y: number | null, viewportHeight: number): string {
  if (y == null) return "não achado";
  return y < viewportHeight
    ? `${y}px (na 1ª tela, que vai até ${viewportHeight}px)`
    : `${y}px (abaixo da 1ª tela: ${y - viewportHeight}px de rolagem)`;
}
