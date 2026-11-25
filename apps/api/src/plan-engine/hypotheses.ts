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

import { pageSpec, partWord } from "./page-types.ts";
import { segmentsForPrompt } from "./segments.ts";
import type {
  DevicePdpBehaviour,
  DiagnosisEvidence,
  ElementLabel,
  PageCapture,
  UxPart,
} from "./types.ts";

/** O passo de julgamento: modelo forte, com visão. */
export const HYPOTHESES_MODEL = "anthropic/claude-opus-5.5";

/** As evidências em texto curto — tabelas, não JSON cru. */
export function evidenceForPrompt(ev: DiagnosisEvidence): string {
  const lines: string[] = [];
  const pct = (a: number, b: number) =>
    b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—";

  if (ev.platform_funnel.length > 0) {
    lines.push(
      `## Funil GA4 por plataforma (usuárias, últimos ${ev.window_days} dias)`,
    );
    for (const f of ev.platform_funnel) {
      const steps = f.steps
        .map((s, i) =>
          i === 0
            ? `${s.event} ${s.count}`
            : `${s.event} ${s.count} (${pct(s.count, f.steps[i - 1]!.count)})`,
        )
        .join(" → ");
      lines.push(`- ${f.platform}: ${steps}`);
    }
  }

  lines.push(...segmentsForPrompt(ev.segments, ev.window_days));

  const spec = pageSpec(ev.page_type);
  const pageName = spec.key === "pdp" ? "PDP" : spec.label.toLowerCase();
  if (ev.routes && ev.routes.length > 1) {
    lines.push(
      `## Rotas de ${pageName} mais vistas (Deco Analytics, 7 dias, todos os dispositivos)`,
    );
    for (const r of ev.routes) {
      lines.push(
        `- ${r.page}: ${r.views} visualizações, rolagem média ${r.avg_depth}%${r.page === ev.page_route ? " ← a analisada (heatmap e print abaixo)" : ""}`,
      );
    }
  }

  for (const b of ev.pdp_behaviour) {
    lines.push(
      `## Comportamento na ${pageName}${ev.page_route && spec.key !== "pdp" ? ` (${ev.page_route})` : ""} — ${b.device} (Deco Analytics, 7 dias)`,
    );
    lines.push(
      `- ${b.views} visualizações; rolagem média ${b.avg_depth_pct}% da página; a primeira tela mostra ${b.avg_fold_pct}% da página (é altura da tela ÷ altura da página, não posição: se uma parte está na 1ª tela, quem diz é a posição em px dela na "Página real"); ${b.active_seconds}s ativos em média`,
    );
    lines.push(
      `- chegam a 25%/50%/75% da página: ${b.reach.p25}% / ${b.reach.p50}% / ${b.reach.p75}%`,
    );
    lines.push(
      `- ${b.clicks} cliques na página inteira; ${b.dead_clicks} mortos (${pct(b.dead_clicks, b.clicks)}: nada reagiu em 1 s). Total da página não diz ONDE: use a tabela de elementos.`,
    );
    if (b.funnel) {
      lines.push(
        `- funil da página: ${b.funnel.visitors} visitantes → ${b.funnel.viewed} viram produto (${pct(b.funnel.viewed, b.funnel.visitors)}) → ${b.funnel.carted} carrinho (${pct(b.funnel.carted, b.funnel.visitors)} das visitantes)`,
      );
    }
    if (b.sections.length > 0) {
      lines.push("- seções (alcance / tempo médio / CTR):");
      for (const s of b.sections) {
        // CTR acima de 100% = a seção fica por cima da página (pop-up,
        // gaveta): o "alcance" mede rolagem e não diz quantos a viram.
        lines.push(
          `  - ${s.section}: ${s.reach_pct}% / ${s.avg_seconds}s / ${s.ctr_pct}%${s.ctr_pct > 100 ? ` — fica POR CIMA da página: o alcance não vale; ${s.clicks} cliques em ${b.views} visualizações` : ""}`,
        );
      }
    }
    const elements = elementsForPrompt(ev, b);
    if (elements.length > 0) {
      lines.push(
        "- elementos (o que é na página real · cliques · % mortos em elemento clicável · de quem clicou, % que pôs no carrinho — isso mede quem ESCOLHEU clicar, não o efeito do elemento):",
      );
      lines.push(...elements.map((l) => `  - ${l}`));
    }
  }

  if (ev.ga4_page_funnel) {
    lines.push(
      `## Funil da ${pageName} (${ev.ga4_page_funnel.route}) no GA4 — quem visitou e, na mesma sessão, viu produto e pôs no carrinho (${ev.window_days} dias; o Deco Analytics não recebe esses eventos desta loja)`,
    );
    for (const f of ev.ga4_page_funnel.by_device) {
      lines.push(
        `- ${f.device}: ${f.visitors} visitantes → ${f.viewed} viram produto (${pct(f.viewed, f.visitors)}) → ${f.carted} carrinho (${pct(f.carted, f.visitors)} das visitantes)`,
      );
    }
  }

  if (ev.revenue) {
    lines.push(
      `## Receita por canal de venda (VTEX, ${ev.revenue.window_days} dias, ${ev.revenue.currency ?? "moeda da loja"})`,
    );
    for (const c of ev.revenue.by_channel) {
      lines.push(
        `- ${c.channel}: ${c.orders} pedidos, ${c.revenue.toFixed(0)} de receita, ticket ${c.avg_ticket.toFixed(0)}`,
      );
    }
  }

  if (ev.products.length > 0) {
    lines.push(
      `## Produtos que puxam tráfego (web, ${ev.window_days} dias) x vendas no site x estoque`,
    );
    for (const p of ev.products.slice(0, 15)) {
      lines.push(
        `- [${p.reason}] ${p.name} (${p.product_id}): ${p.views} views, ${p.orders} vendidos, ${p.orders_per_1k_views}/mil views, estoque ${p.available_skus}/${p.total_skus} tamanhos`,
      );
    }
  }

  for (const c of ev.captures) {
    const pos = c.positions;
    // 13/11, numa loja, duas rodadas seguidas: "preço só em y=699" virou
    // "abaixo da dobra" numa tela de 844px, lendo os 18,5% da Deco Analytics
    // como posição. A conta da dobra sai daqui, não do modelo.
    const px = (v: number | null | undefined) =>
      foldNote(v ?? null, c.viewport.height);
    lines.push(
      `## Página real — ${c.device} (${c.viewport.width}×${c.viewport.height}) ${c.url}${stockNote(c.stock)}`,
    );
    if (spec.key === "pdp") {
      lines.push(
        `- altura ${c.page_height}px; preço ${px(pos.price)}; tamanho ${px(pos.size_selector)}; botão de compra ${px(pos.buy_button)}; frete ${px(pos.shipping)}; 1ª recomendação ${px(pos.first_recommendation)}`,
      );
      lines.push(
        `- barra de compra fixa: ${c.has_sticky_buy ? "sim" : "não"}; sinal de esgotado na página: ${c.sold_out_signal ? "sim" : "não"}`,
      );
    } else {
      const parts = (Object.keys(spec.parts) as UxPart[])
        .map((k) => `${partWord(spec.key, k)} ${px(pos[k])}`)
        .join("; ");
      lines.push(`- altura ${c.page_height}px; ${parts}`);
      const facts = factsForPrompt(c.facts);
      if (facts) lines.push(`- ${facts}`);
    }
    lines.push(
      `- primeira tela: ${c.above_fold_outline.slice(0, 18).join(" | ")}`,
    );
  }

  if (ev.benchmark.length > 0) {
    lines.push(`## Concorrentes (${pageName} no celular)`);
    for (const b of ev.benchmark) {
      const a = b.anatomy;
      const yn = (v: boolean | null) => (v == null ? "?" : v ? "sim" : "não");
      lines.push(
        spec.key === "pdp"
          ? `- ${b.domain}: barra fixa ${yn(a.sticky_buy)}, tamanho na dobra ${yn(a.size_above_fold)}, prazo sem CEP ${yn(a.shipping_estimate)}, salvar ${yn(a.wishlist)}, recomendação ${a.recommendation_position ?? "?"}. ${a.notes}`
          : `- ${b.domain} (${b.url}): ${a.notes}`,
      );
      for (const [area, text] of Object.entries(a.by_area ?? {})) {
        lines.push(`  - ${area}: ${text}`);
      }
    }
  }

  if (ev.gaps.length > 0) {
    lines.push("## Fontes que NÃO responderam (não invente o que elas diriam)");
    for (const g of ev.gaps) lines.push(`- ${g.source}: ${g.error}`);
  }
  return lines.join("\n");
}

/** Rótulos dos fatos medidos fora da PDP (measureSitePageInPage). */
const FACT_LABEL: Record<string, string> = {
  cards_above_fold: "cards de produto na primeira tela",
  cards_per_row: "cards por linha",
  cards_total: "cards carregados",
  results_total: "total de resultados que a página diz",
  hero_height: "altura do destaque (px)",
  hero_is_carousel: "destaque é carrossel",
  shelves: "vitrines de produto na página",
  sticky_header: "cabeçalho fixo ao rolar",
  sticky_filter: "filtro fixo ao rolar",
  card_has_price: "card mostra preço",
  card_has_swatches: "card mostra cores",
  card_has_installments: "card mostra parcelamento",
  card_has_badge: "card tem selo (desconto, novo…)",
  card_has_buy: "card tem botão de comprar",
  no_results: "página de nenhum resultado",
  pagination: "como a lista continua",
};

export function factsForPrompt(
  facts: PageCapture["facts"] | undefined,
): string {
  if (!facts) return "";
  return Object.entries(facts)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const value = v === true ? "sim" : v === false ? "não" : String(v);
      return `${FACT_LABEL[k] ?? k}: ${value}`;
    })
    .join("; ");
}

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
