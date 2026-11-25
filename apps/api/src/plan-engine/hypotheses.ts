/**
 * Das evidências às hipóteses — o passo que a análise manual fazia na cabeça.
 *
 * O prompt carrega o MÉTODO dos relatórios (pdp-oportunidades e companhia),
 * não um gabarito de respostas: comparar mobile com desktop (mesma loja, outra
 * tela; o app é outro público), achar a etapa de maior perda, recortar por
 * dispositivo/seção/produto, olhar a página de verdade e o que os concorrentes
 * fazem, e escrever cada hipótese no formato fixo com a conta do dinheiro.
 *
 * O que o modelo NÃO decide: a aritmética (money.ts recalcula) e a ordem (rank
 * = valor × confiança, calculado aqui). Hipótese sem número na evidência ou sem
 * conta válida é descartada — e o descarte vira um "limite" na tela, não some.
 */

import type {
  DevicePdpBehaviour,
  DiagnosisEvidence,
  ElementLabel,
  PageCapture,
} from "./types.ts";

/**
 * Estoque do produto do print, em palavras. Uma PDP com a grade quebrada mostra
 * "Avise-me" e tamanhos apagados; sem o aviso, o modelo trata isso como a PDP
 * de sempre.
 */
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

/**
 * Uma linha por elemento do heatmap, com o rótulo que a captura do mesmo
 * dispositivo achou. Sem rótulo, fica a seção e "elemento não achado na
 * página": é melhor que um nome inventado.
 */
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
    // Morto num elemento que troca de página = a página nova levou mais
    // de 1 s (ou o envio vazio não saiu, de propósito). Não é botão quebrado.
    const dead = `mortos ${pct(e.dead_interactive, e.clicks)}${l?.navigates && e.dead_interactive > 0 ? " (troca de página: morto aqui é a página nova demorando > 1 s, não falha)" : ""}`;
    return `${what} · ${e.clicks} cliques · ${dead} · ${cart}`;
  });
}

/**
 * O rótulo de um elemento como o prompt lê: o que é, pra onde leva, e onde
 * está. O y de um elemento escondido na carga (num painel que outro clique
 * abre) é 0 e não é posição: sai no lugar dele "escondido na carga".
 */
export function describeElementLabel(l: ElementLabel): string {
  const to = l.navigates ? ` → leva pra ${l.navigates}` : "";
  const where = l.hidden
    ? "escondido na carga: só aparece depois de abrir outra coisa"
    : `y=${l.y}px`;
  return `${l.label}${to} (${where})`;
}

/**
 * Posição de uma parte contra a altura da tela: "699px (na 1ª tela, que vai
 * até 844px)". Exportado pra teste.
 */
export function foldNote(y: number | null, viewportHeight: number): string {
  if (y == null) return "não achado";
  return y < viewportHeight
    ? `${y}px (na 1ª tela, que vai até ${viewportHeight}px)`
    : `${y}px (abaixo da 1ª tela: ${y - viewportHeight}px de rolagem)`;
}
