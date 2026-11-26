/**
 * The diagnosis fact ledger: the evidence broken into atomic facts with an id
 * (F1, F2...), each with source, device and whether it was MEASURED in code or
 * READ by an AI. Whoever asserts a claim cites ids, and code checks that the
 * ids exist, that every number is in a cited fact (or is their difference, sum
 * or ratio), and that "fato_observado" only cites MEASURED facts. Facts are
 * stored in `evidence.facts` so ids stay stable across verification and dossier.
 */

import { elementsForPrompt, stockNote } from "./hypotheses.ts";
import { pageSpec, partWord } from "./page-types.ts";
import type {
  DiagnosisEvidence,
  UxDevice,
  UxPart,
  UxSourceKind,
} from "./types.ts";

export type UxFactKind =
  | "funil"
  | "recorte"
  | "rota"
  | "comportamento"
  | "secao"
  | "elemento"
  | "posicao"
  | "pagina"
  | "receita"
  | "produto"
  | "concorrente"
  | "interacao"
  | "verificacao";

export interface UxFact {
  /** F1, F2... in the order the ledger was built. */
  id: string;
  kind: UxFactKind;
  source: UxSourceKind;
  /** NULL = applies to both screens, or is from the app. */
  device: UxDevice | null;
  /** Measured in code. false = read by an AI from a screenshot: a signal, not a fact about this store. */
  measured: boolean;
  /** The block title in the prompt ("Real page - mobile (390x844) ..."). */
  group: string;
  /** The sentence, with the number, as it goes into the prompt. */
  text: string;
}

const pct = (a: number, b: number) =>
  b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—";

const deviceOfPlatform = (platform: string): UxDevice | null =>
  platform === "web_mobile"
    ? "mobile"
    : platform === "web_desktop"
      ? "desktop"
      : null;

const PLATFORM_WORD: Record<string, string> = {
  web_mobile: "site no celular",
  web_desktop: "site no computador",
  app_ios: "app iOS",
  app_android: "app Android",
};

/** A part's position, stated against the height of the first screen. */
function positionText(y: number | null | undefined, fold: number): string {
  if (y == null) return "não achado na página";
  return y < fold
    ? `y=${y}px, na 1ª tela (que vai até ${fold}px)`
    : `y=${y}px, abaixo da 1ª tela (${fold}px): ${y - fold}px de rolagem`;
}

const PAGE_FACT_LABEL: Record<string, string> = {
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

/** The evidence -> facts, always in the same order (the id depends on it). */
export function buildFacts(ev: DiagnosisEvidence): UxFact[] {
  const out: UxFact[] = [];
  const add = (f: Omit<UxFact, "id">) =>
    out.push({ id: `F${out.length + 1}`, ...f });

  const spec = pageSpec(ev.page_type);
  const pageName = spec.key === "pdp" ? "PDP" : spec.label.toLowerCase();

  // GA4 funnel: one step per fact, with the rate over the previous step.
  for (const f of ev.platform_funnel ?? []) {
    const group = `Funil GA4 — ${PLATFORM_WORD[f.platform] ?? f.platform} (usuárias, ${ev.window_days} dias, todas as páginas)`;
    for (const [i, s] of f.steps.entries()) {
      const prev = i > 0 ? f.steps[i - 1] : null;
      add({
        kind: "funil",
        source: "ga4",
        device: deviceOfPlatform(f.platform),
        measured: true,
        group,
        text: prev
          ? `${s.event}: ${s.count} (${pct(s.count, prev.count)} de ${prev.event})`
          : `${s.event}: ${s.count}`,
      });
    }
  }

  // GA4 breakdowns: viewed product -> cart by channel and by new x returning.
  for (const dim of ["canal", "visitante"] as const) {
    const totals: Record<string, number> = {};
    const rows: Array<{
      key: string;
      platform: "web_mobile" | "web_desktop";
      n: number;
      rate: number;
    }> = [];
    for (const s of ev.segments ?? []) {
      if (s.dim !== dim) continue;
      if (s.platform !== "web_mobile" && s.platform !== "web_desktop") continue;
      const n = s.steps.find((x) => x.event === "view_item")?.count ?? 0;
      const hits = s.steps.find((x) => x.event === "add_to_cart")?.count ?? 0;
      if (n <= 0) continue;
      totals[s.platform] = (totals[s.platform] ?? 0) + n;
      rows.push({ key: s.key, platform: s.platform, n, rate: hits / n });
    }
    rows.sort((a, b) =>
      a.key === b.key
        ? a.platform.localeCompare(b.platform)
        : b.n - a.n || a.key.localeCompare(b.key),
    );
    const group =
      dim === "canal"
        ? `Recortes do GA4 por canal de aquisição (1º toque) — viu produto → carrinho, ${ev.window_days} dias`
        : `Recortes do GA4: usuária nova × recorrente — viu produto → carrinho, ${ev.window_days} dias`;
    for (const r of rows) {
      add({
        kind: "recorte",
        source: "ga4",
        device: deviceOfPlatform(r.platform),
        measured: true,
        group,
        text: `${r.key}, ${r.platform === "web_mobile" ? "celular" : "computador"}: ${(r.rate * 100).toFixed(1)}% põem no carrinho; ${r.n} viram produto (${pct(r.n, totals[r.platform] ?? 0)} de quem viu produto nessa tela)`,
      });
    }
  }

  if (ev.routes && ev.routes.length > 1) {
    const group = `Rotas de ${pageName} mais vistas (Deco Analytics, 7 dias, todos os dispositivos)`;
    for (const r of ev.routes) {
      add({
        kind: "rota",
        source: "deco_analytics",
        device: null,
        measured: true,
        group,
        text: `${r.page}: ${r.views} visualizações, rolagem média ${r.avg_depth}%${r.page === ev.page_route ? " (a rota analisada)" : ""}`,
      });
    }
  }

  if (ev.ga4_page_funnel) {
    const group = `Funil da ${pageName} (${ev.ga4_page_funnel.route}) no GA4 — mesma sessão, ${ev.window_days} dias (o Deco Analytics não recebe os eventos de produto e carrinho desta loja)`;
    for (const f of ev.ga4_page_funnel.by_device) {
      add({
        kind: "comportamento",
        source: "ga4",
        device: f.device,
        measured: true,
        group,
        text: `funil da página, ${f.device === "mobile" ? "celular" : "computador"}: ${f.visitors} visitantes → ${f.viewed} viram produto (${pct(f.viewed, f.visitors)}) → ${f.carted} carrinho (${pct(f.carted, f.visitors)} das visitantes)`,
      });
    }
  }

  for (const b of ev.pdp_behaviour ?? []) {
    const group = `Comportamento na ${pageName}${ev.page_route && spec.key !== "pdp" ? ` (${ev.page_route})` : ""} — ${b.device} (Deco Analytics, 7 dias)`;
    const base = {
      source: "deco_analytics" as const,
      device: b.device,
      measured: true,
      group,
    };
    add({
      ...base,
      kind: "comportamento",
      text: `${b.views} visualizações; rolagem média ${b.avg_depth_pct}% da página; ${b.active_seconds}s ativos em média`,
    });
    add({
      ...base,
      kind: "comportamento",
      text: `a primeira tela mostra ${b.avg_fold_pct}% da altura da página (é proporção, não posição: se uma parte está na 1ª tela, quem diz é a posição em px dela)`,
    });
    add({
      ...base,
      kind: "comportamento",
      text: `chegam a 25% / 50% / 75% da página: ${b.reach.p25}% / ${b.reach.p50}% / ${b.reach.p75}%`,
    });
    add({
      ...base,
      kind: "comportamento",
      text: `${b.clicks} cliques na página inteira, ${b.dead_clicks} mortos (${pct(b.dead_clicks, b.clicks)}: nada reagiu em 1 s). O total da página não diz ONDE`,
    });
    if (b.funnel) {
      add({
        ...base,
        kind: "comportamento",
        text: `funil da página: ${b.funnel.visitors} visitantes → ${b.funnel.viewed} viram produto (${pct(b.funnel.viewed, b.funnel.visitors)}) → ${b.funnel.carted} carrinho (${pct(b.funnel.carted, b.funnel.visitors)} das visitantes)`,
      });
    }
    for (const s of b.sections ?? []) {
      // A CTR above 100% means the section sits over the page (pop-up, drawer): "reach" measures scrolling and does not say how many saw it.
      add({
        ...base,
        kind: "secao",
        text:
          s.ctr_pct > 100
            ? `seção ${s.section}: fica POR CIMA da página (CTR ${s.ctr_pct}%), então o alcance de rolagem (${s.reach_pct}%) não vale; ${s.clicks} cliques em ${b.views} visualizações; ${s.avg_seconds}s em média`
            : `seção ${s.section}: alcance ${s.reach_pct}%, ${s.avg_seconds}s em média, CTR ${s.ctr_pct}%`,
      });
    }
    const elementsGroup = `Elementos clicados na ${pageName} — ${b.device} (o que é na página real · cliques · % mortos em elemento clicável · de quem clicou, % que pôs no carrinho: mede quem ESCOLHEU clicar, não o efeito do elemento)`;
    for (const line of elementsForPrompt(ev, b)) {
      add({ ...base, group: elementsGroup, kind: "elemento", text: line });
    }
  }

  if (ev.revenue) {
    const group = `Receita por canal de venda (VTEX, ${ev.revenue.window_days} dias, ${ev.revenue.currency ?? "moeda da loja"})`;
    for (const c of ev.revenue.by_channel) {
      add({
        kind: "receita",
        source: "vtex",
        device: null,
        measured: true,
        group,
        text: `${c.channel}: ${c.orders} pedidos, ${c.revenue.toFixed(0)} de receita, ticket ${c.avg_ticket.toFixed(0)}`,
      });
    }
  }

  if (ev.products?.length) {
    const group = `Produtos que puxam tráfego (web, ${ev.window_days} dias) × vendas no site × estoque`;
    for (const p of ev.products.slice(0, 15)) {
      add({
        kind: "produto",
        source: "ga4",
        device: null,
        measured: true,
        group,
        text: `[${p.reason}] ${p.name} (${p.product_id}): ${p.views} views, ${p.orders} vendidos, ${p.orders_per_1k_views}/mil views, estoque ${p.available_skus}/${p.total_skus} tamanhos`,
      });
    }
  }

  for (const c of ev.captures ?? []) {
    if (!c.viewport) continue;
    const fold = c.viewport.height;
    const group = `Página real — ${c.device} (${c.viewport.width}×${c.viewport.height}) ${c.url}${stockNote(c.stock)}`;
    const base = {
      kind: "posicao" as const,
      source: "pagina" as const,
      device: c.device,
      measured: true,
      group,
    };
    add({
      ...base,
      kind: "pagina",
      text: `altura da página ${c.page_height}px; a 1ª tela vai até ${fold}px`,
    });
    for (const part of Object.keys(spec.parts) as UxPart[]) {
      if (!c.positions || !(part in c.positions)) continue;
      add({
        ...base,
        text: `${partWord(spec.key, part)}: ${positionText(c.positions[part], fold)}`,
      });
    }
    if (spec.key === "pdp") {
      add({
        ...base,
        kind: "pagina",
        text: `barra de compra fixa ao rolar: ${c.has_sticky_buy ? "sim" : "não"}`,
      });
      add({
        ...base,
        kind: "pagina",
        text: `a página fala em esgotado/avise-me: ${c.sold_out_signal ? "sim" : "não"}`,
      });
    }
    for (const [k, v] of Object.entries(c.facts ?? {})) {
      if (v === null || v === undefined || v === "") continue;
      add({
        ...base,
        kind: "pagina",
        text: `${PAGE_FACT_LABEL[k] ?? k}: ${v === true ? "sim" : v === false ? "não" : String(v)}`,
      });
    }
    if (c.above_fold_outline?.length) {
      add({
        ...base,
        kind: "pagina",
        text: `o que aparece na 1ª tela, de cima pra baixo: ${c.above_fold_outline.slice(0, 18).join(" | ")}`,
      });
    }
  }

  for (const r of ev.probes ?? []) {
    const word = r.device === "mobile" ? "celular" : "computador";
    const base = {
      kind: "interacao" as const,
      source: "pagina" as const,
      device: r.device,
      measured: true,
    };
    if (r.kind === "camadas") {
      const group = `Sonda — ${word}: a página aberta SEM fechar pop-up nem banner, depois de mexer o mouse (${r.url})`;
      if (!r.ok) {
        add({
          ...base,
          group,
          text: `a sonda de camadas não rodou: ${r.error}`,
        });
        continue;
      }
      const { overlays, covered, viewport } = r.reading;
      if (overlays.length === 0) {
        add({
          ...base,
          group,
          text: "nenhuma camada fixa cobre 10% ou mais da 1ª tela",
        });
      }
      for (const o of overlays) {
        add({
          ...base,
          group,
          text: `camada fixa${o.dialog ? " (diálogo)" : ""} "${o.text || "sem texto"}": cobre ${o.area_pct}% da 1ª tela (${viewport.width}×${viewport.height}), de y=${o.top} a y=${o.bottom}px${o.dims_page ? "; uma película escurece a tela inteira por trás" : ""}${o.blocks_page ? "; o resto da página não responde ao toque enquanto ela está aberta" : ""}`,
        });
      }
      for (const part of Object.keys(spec.parts) as UxPart[]) {
        const c = covered[part];
        if (c === undefined || c === null) continue;
        add({
          ...base,
          group,
          text: `${partWord(spec.key, part)}: ${c ? "COBERTO por uma camada fixa ao abrir a página" : "na 1ª tela e sem camada por cima"}`,
        });
      }
      continue;
    }
    const group = `Sonda — ${word}: tocamos nos elementos com muito clique morto (rastreio bloqueado; sacola, checkout e login proibidos)`;
    const label = r.label ?? r.key ?? "elemento";
    add({
      ...base,
      group,
      text: !r.ok
        ? `a sonda de toque em ${label} não rodou: ${r.error}`
        : r.clicked
          ? `tocar em ${label}: ${r.observed.slice(0, 400)}`
          : `não toquei em ${label}: ${r.observed.slice(0, 400)}`,
    });
  }

  for (const b of ev.benchmark ?? []) {
    const group = `Concorrentes (${pageName} no celular) — lido por IA no print: é sinal de mercado, não fato desta loja`;
    const a = b.anatomy;
    if (!a) continue;
    const yn = (v: boolean | null) => (v == null ? "?" : v ? "sim" : "não");
    const base = {
      kind: "concorrente" as const,
      source: "benchmark" as const,
      device: "mobile" as const,
      measured: false,
      group,
    };
    add({
      ...base,
      text:
        spec.key === "pdp"
          ? `${b.domain}: barra fixa ${yn(a.sticky_buy)}, tamanho na 1ª tela ${yn(a.size_above_fold)}, preço na 1ª tela ${yn(a.price_above_fold)}, prazo sem CEP ${yn(a.shipping_estimate)}, salvar ${yn(a.wishlist)}, recomendação ${a.recommendation_position ?? "?"}. ${a.notes}`.trim()
          : `${b.domain} (${b.url}): ${a.notes}`,
    });
    for (const [area, what] of Object.entries(a.by_area ?? {})) {
      add({ ...base, text: `${b.domain}, ${area}: ${what}` });
    }
  }

  return out;
}

/** New facts appended to the ledger with the following ids; old ids never change. */
export function appendFacts(
  book: UxFact[],
  items: Array<Omit<UxFact, "id">>,
): UxFact[] {
  const last = book.reduce(
    (m, f) => Math.max(m, Number(f.id.slice(1)) || 0),
    0,
  );
  return [...book, ...items.map((f, i) => ({ ...f, id: `F${last + i + 1}` }))];
}

/** This diagnosis's facts: the stored ones, or built now (old evidence). */
export function factBook(ev: DiagnosisEvidence): UxFact[] {
  return ev.facts && ev.facts.length > 0 ? ev.facts : buildFacts(ev);
}

/** The ledger as prompt text: one block per group, one line per fact; unanswered sources go last. */
export function factBookForPrompt(
  facts: UxFact[],
  gaps: DiagnosisEvidence["gaps"] = [],
): string {
  const lines: string[] = [
    "# Fatos (cite pelo id: [F12]. Fato sem id não existe; número fora dos fatos é inventado)",
  ];
  let group = "";
  for (const f of facts) {
    if (f.group !== group) {
      group = f.group;
      lines.push(`## ${group}`);
    }
    lines.push(`- ${f.id}: ${f.text}`);
  }
  if (gaps.length > 0) {
    lines.push("## Fontes que NÃO responderam (não invente o que elas diriam)");
    for (const g of gaps) lines.push(`- ${g.source}: ${g.error}`);
  }
  return lines.join("\n");
}

const SOURCE_WORD: Record<UxSourceKind, string> = {
  ga4: "GA4",
  deco_analytics: "Deco Analytics",
  vtex: "VTEX",
  pagina: "página real",
  benchmark: "concorrente",
};

/** A fact for the reader: source, screen and sentence, plus "read by AI" when not measured. No id. */
export function factLine(f: UxFact): string {
  const where = [
    f.kind === "interacao"
      ? "sonda na página"
      : f.kind === "verificacao"
        ? "verificação"
        : SOURCE_WORD[f.source],
    f.device === "mobile"
      ? "celular"
      : f.device === "desktop"
        ? "computador"
        : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${where}: ${f.text}${f.measured ? "" : " (lido por IA)"}`;
}

// ── Citation check ──────────────────────────────────────────────────────────

/** Fact ids in a model answer: ["F12", "f3"], "F12, F14" or "[F12]". */
export function parseFactIds(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const item of items) {
    for (const m of String(item).matchAll(/\bF(\d+)\b/gi)) {
      const id = `F${Number(m[1])}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

export interface ParsedNumber {
  /** As written ("9,9%", "1.031px"). */
  raw: string;
  value: number;
  /** Decimal places written (the comparison tolerance). */
  decimals: number;
  /** Spelled-out multiplier: "72,5 mil" = 72,500. */
  scale: number;
}

/**
 * The numbers in a sentence, skipping non-measures (ids, ordinals, small
 * unitless integers). A dot followed by 3 digits is a thousands separator.
 */
export function numbersIn(text: string, all = false): ParsedNumber[] {
  const out: ParsedNumber[] = [];
  const re = /(?<![\p{L}\d.,])(\d{1,3}(?:\.\d{3})+(?!\d)|\d+)(?:[.,](\d+))?/gu;
  for (const m of text.matchAll(re)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    // Ordinals (1ª, 2º) and word fragments (3D, 4G) are not measures.
    if (/^[ªº°]/.test(rest)) continue;
    const unitMatch =
      /^\s*(%|px|pp|×|x(?!\p{L})|s(?!\p{L})|mil(?!\p{L})|mi(?!\p{L})|milh)/iu.exec(
        rest,
      );
    if (!unitMatch && /^\p{L}/u.test(rest)) continue;
    const unit = (unitMatch?.[1] ?? "").toLowerCase();
    const intPart = m[1]!.replace(/\./g, "");
    const dec = m[2] ?? "";
    const value = Number(dec ? `${intPart}.${dec}` : intPart);
    if (!Number.isFinite(value)) continue;
    const scale =
      unit === "mil" ? 1_000 : unit === "mi" || unit === "milh" ? 1_000_000 : 1;
    if (!all && !unit && !dec && value <= 10) continue;
    out.push({
      raw: `${m[0]}${unitMatch?.[0] ?? ""}`.trim(),
      value,
      decimals: dec.length,
      scale,
    });
  }
  return out;
}

/** Does the written number match `m`, rounded as it was written? */
function matches(n: ParsedNumber, m: number): boolean {
  const written = n.value * n.scale;
  const tolerance = (0.5 * n.scale) / 10 ** n.decimals + 1e-9;
  return Math.abs(Math.abs(m) - written) <= tolerance;
}

/** A number is supported if it is a cited fact's number, or the difference, sum or ratio (x1 or x100) of two. */
export function isSupported(
  n: ParsedNumber,
  pool: number[],
  derived = true,
): boolean {
  if (pool.some((m) => matches(n, m))) return true;
  if (!derived) return false;
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const a = pool[i]!;
      const b = pool[j]!;
      if (matches(n, a - b) || matches(n, a + b)) return true;
      if (b !== 0 && (matches(n, a / b) || matches(n, (a / b) * 100))) {
        return true;
      }
    }
  }
  return false;
}

export interface Grounding {
  /** The cited facts that exist. */
  facts: UxFact[];
  /** Cited ids that do not exist in this diagnosis. */
  unknown: string[];
  /** Numbers in the sentence that no cited fact supports. */
  unsupported: string[];
}

/** Checks a sentence against the facts it cites; the caller decides what to do. */
export function checkGrounding(
  text: string,
  ids: string[],
  book: Map<string, UxFact>,
  /** Accept the difference/sum/ratio of two cited numbers. Turn off against the whole ledger, where almost everything becomes "derived". */
  derived = true,
): Grounding {
  const facts: UxFact[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const f = book.get(id);
    if (f) facts.push(f);
    else unknown.push(id);
  }
  const pool = facts.flatMap((f) =>
    numbersIn(f.text, true).map((n) => n.value * n.scale),
  );
  const unsupported = numbersIn(text)
    .filter((n) => !isSupported(n, pool, derived))
    .map((n) => n.raw);
  return { facts, unknown, unsupported };
}

/** Index id -> fact. */
export function factIndex(facts: UxFact[]): Map<string, UxFact> {
  return new Map(facts.map((f) => [f.id, f]));
}
