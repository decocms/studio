/**
 * Funções que rodam DENTRO da página, via `page.evaluate`.
 *
 * ⚠️ Cada função aqui é serializada (`fn.toString()`) e executada no Chrome.
 * Ela não pode usar nada de fora do próprio corpo: nem import, nem constante do
 * módulo, nem helper de outro arquivo. Um helper compartilhado precisa ser
 * declarado dentro de cada função que o usa. Quebrar isso não dá erro de tipo —
 * dá `ReferenceError` em produção, dentro do navegador.
 *
 * Tudo é heurística sobre o DOM de uma loja qualquer, porque o módulo é
 * genérico: não há seletor de loja nenhuma aqui. Quando a heurística não acha, o campo
 * volta `null` e o diagnóstico diz "não achei", em vez de chutar.
 */

import type { ClickSnapshot, ElementFacts } from "./verify/safety.ts";

// ── Texto visível ────────────────────────────────────────────────────────────

/** O mínimo de um nó do DOM que `visibleTextOf` lê (um Node de verdade serve). */
export interface TextTreeNode {
  nodeType: number;
  nodeValue: string | null;
  localName?: string;
  firstChild: TextTreeNode | null;
  nextSibling: TextTreeNode | null;
}

/**
 * Texto de um nó sem o conteúdo de SCRIPT, STYLE, NOSCRIPT e TEMPLATE. NÃO roda
 * na página: é a cópia testável do `visibleText` que cada função in-page declara
 * por dentro (regra de serialização acima); o teste confere que os corpos são
 * iguais. Motivo (14/11): o textContent do botão de compra de uma loja é
 * `{"name":"add_to_cart",...}Adicionar à sacola`.
 */
export function visibleTextOf(node: TextTreeNode): string {
  let out = "";
  const walk = (n: typeof node): void => {
    if (n.nodeType === 3) out += n.nodeValue ?? "";
    if (n.nodeType !== 1) return;
    const tag = (n as { localName?: string }).localName ?? "";
    if (/^(script|style|noscript|template)$/i.test(tag)) return;
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(node);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Rótulo de um nó: o texto visível sem SCRIPT/STYLE/NOSCRIPT/TEMPLATE e sem
 * sub-árvore escondida (`hidden(n)`: display none, visibility hidden). O
 * rótulo do seletor de tamanho de uma loja saía com o tooltip escondido
 * "vendido por parceiro..." (revisão, 14/11). Só pra EXIBIR: a trava de
 * clique continua lendo o texto inteiro (`visibleTextOf`), de propósito.
 *
 * Cópia igual em `const labelText = (node, hidden) => {...}` nas funções da
 * página (o teste confere).
 */
export function labelTextOf(
  node: TextTreeNode,
  hidden: (n: TextTreeNode) => boolean,
): string {
  let out = "";
  const walk = (n: typeof node): void => {
    if (n.nodeType === 3) out += n.nodeValue ?? "";
    if (n.nodeType !== 1) return;
    const tag = (n as { localName?: string }).localName ?? "";
    if (/^(script|style|noscript|template)$/i.test(tag)) return;
    if (hidden(n)) return;
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(node);
  return out.replace(/\s+/g, " ").trim();
}

/** O mínimo de um elemento que `navigationOf` lê (um Element de verdade serve). */
export interface ActionNode {
  localName: string;
  getAttribute(name: string): string | null;
  closest(selector: string): ActionNode | null;
}

/**
 * Pra onde um clique no elemento leva o navegador (caminho, ou host+caminho se
 * for outro site), ou "" se ele não troca de página: link com href de verdade,
 * ou botão de envio dentro de formulário. Isso importa pro clique morto: o
 * Deco Analytics chama de morto o clique em que a página não muda em 1 s, e
 * uma navegação que demora mais que isso conta como morta. Em 16/11 o envio
 * da busca de uma loja (`button[type=submit] "Search term"`) saiu com 56% de
 * mortos e virou "botão que não responde", com 23% de quem tocou indo ao
 * carrinho.
 *
 * Cópia igual em `const navigationOf = (e, here) => {...}` dentro de
 * `elementLabelsInPage` (o teste confere).
 */
export function navigationOf(e: ActionNode, here: string): string {
  let to = "";
  const link = e.closest("a[href]");
  if (link) {
    const href = (link.getAttribute("href") ?? "").trim();
    if (
      href &&
      !href.startsWith("#") &&
      !/^(javascript|mailto|tel):/i.test(href)
    ) {
      to = href;
    }
  } else {
    const button = e.closest(
      "button, input[type='submit'], input[type='image']",
    );
    const form = button ? button.closest("form") : null;
    if (button && form) {
      const type = (
        button.getAttribute("type") ??
        (button.localName === "button" ? "submit" : "")
      ).toLowerCase();
      if (type === "submit" || type === "image") {
        to = (form.getAttribute("action") ?? "").trim() || here;
      }
    }
  }
  if (!to) return "";
  try {
    const url = new URL(to, here);
    const base = new URL(here);
    return url.host === base.host ? url.pathname : `${url.host}${url.pathname}`;
  } catch {
    return "";
  }
}

// ── Fechar banners ───────────────────────────────────────────────────────────

/**
 * Aceita cookies e some com modais que cobrem a página (newsletter, cupom de
 * primeira compra). Só esconde camada FIXA que cobre mais da metade da tela —
 * header e barra de compra fixa ficam, porque são justamente o que se mede.
 */
export function dismissOverlaysInPage(): void {
  const accept = [
    "#onetrust-accept-btn-handler",
    "#onetrust-close-btn-container button",
    "[id*='cookie'] button",
    "[class*='cookie'] button",
    "[aria-label*='fechar' i]",
    "[aria-label*='close' i]",
  ];
  for (const selector of accept) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        try {
          (el as HTMLElement).click();
        } catch {
          /* elemento sumiu no meio */
        }
      }
    }
  }
  const area = window.innerWidth * window.innerHeight;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const style = getComputedStyle(el);
    if (style.position !== "fixed") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height > area * 0.5) {
      (el as HTMLElement).style.setProperty("display", "none", "important");
    }
  }
  // Só destrava o que o modal travou (overflow hidden/clip). Forçar `auto` no
  // <html> de uma loja, que é `visible` com o <body> em `auto`, tirava a rolagem
  // da janela e passava pro <body>: `scrollTo` parava de mexer (14/11).
  for (const el of [document.documentElement, document.body]) {
    if (/(hidden|clip)/.test(getComputedStyle(el).overflowY)) {
      el.style.setProperty("overflow", "auto", "important");
    }
  }
}

// ── Rolar a página ───────────────────────────────────────────────────────────

/**
 * O elemento que rola a página quando não é (só) a janela: o <body> com
 * overflow auto/scroll e conteúdo maior que ele, ou o maior elemento assim que
 * cubra a tela. `null` = quem rola é a janela. Numa loja, com o <html> em
 * `overflow: auto`, `window.scrollTo(0, 1000)` deixava `scrollY = 0` e quem
 * rolava era o <body> (14/11).
 *
 * Cada função in-page que rola ou mede posição declara uma cópia deste corpo
 * em `const pageScroller = () => {...}`; o teste confere que são iguais.
 */
export function pageScrollerInPage(): Element | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scrolls = (el: Element): boolean => {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
    const s = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
    if (s.position === "fixed") return false;
    // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  };
  const body = document.body;
  if (!body) return null;
  if (scrolls(body)) return body;
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (!scrolls(el)) continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Rola a página até `y` (px do topo do documento) e devolve a rolagem que
 * ficou de fato. Rola a janela e, no que ela não alcançou, o elemento que rola
 * a página (`pageScrollerInPage`). "instant" nos dois: uma loja tem
 * `scroll-behavior: smooth` e, sem isso, `scrollY` ainda é 0 logo depois do
 * `scrollTo` (14/11). Único caminho de rolagem do módulo.
 */
export function scrollPageToInPage(y: number): number {
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const target = Math.max(0, Math.round(y));
  window.scrollTo({ top: target, left: 0, behavior: "instant" });
  const scroller = pageScroller();
  if (scroller) {
    scroller.scrollTo({
      top: Math.max(0, target - window.scrollY),
      left: 0,
      behavior: "instant",
    });
  }
  return Math.round(window.scrollY + (scroller ? scroller.scrollTop : 0));
}

/**
 * Topo de `selector` em px do documento (com a rolagem do rolador certo), ou
 * `null` se o seletor não casa. Pro `screenshotAt` mirar o elemento (14/11).
 */
export function elementDocTopInPage(selector: string): number | null {
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return null;
  }
  if (!el) return null;
  const scroller = pageScroller();
  const scrolled =
    window.scrollY + (scroller?.contains(el) ? scroller.scrollTop : 0);
  return Math.round(el.getBoundingClientRect().top + scrolled);
}

// ── Preço e botão "desta peça" ──────────────────────────────────────────────

/**
 * Preço DESTE produto, de onde a página declara: JSON-LD `Product` (o
 * primeiro com `offers`), depois `[itemprop=price]`/meta de preço, depois o
 * `view_item` do dataLayer (GA4/UA). Uma loja não tem JSON-LD nem meta: o
 * valor só aparece no `view_item` (14/11). `from: null` = não achou.
 *
 * NÃO roda sozinha na página: `measurePdpInPage` declara uma cópia igual em
 * `const productPriceValues = (...) => {...}` (o teste confere).
 */
export function productPriceValues(
  ldTexts: string[],
  metaValues: string[],
  layer: unknown,
): {
  values: number[];
  list: number[];
  from: "json-ld" | "meta" | "dataLayer" | null;
} {
  const out: number[] = [];
  // Preço de lista (o "de" riscado) à parte: só vale se o de venda não
  // aparecer em lugar nenhum (revisão, 14/11).
  const list: number[] = [];
  const add = (v: unknown, into: number[] = out): void => {
    let n = Number.NaN;
    if (typeof v === "number") n = v;
    else if (typeof v === "string") {
      const t = v.replace(/[^\d.,]/g, "");
      // "1.998" é milhar, não decimal: ponto seguido de 3 dígitos no fim
      // (revisão, 14/11).
      n = Number.parseFloat(
        /,\d{1,2}$/.test(t)
          ? t.replace(/\./g, "").replace(",", ".")
          : /\.\d{3}$/.test(t)
            ? t.replace(/[.,]/g, "")
            : t.replace(/,/g, ""),
      );
    }
    if (Number.isFinite(n) && n > 0 && !into.includes(n)) into.push(n);
  };
  const offerPrices = (offers: unknown, depth: number): void => {
    if (depth > 3) return;
    for (const o of Array.isArray(offers) ? offers : [offers]) {
      if (!o || typeof o !== "object") continue;
      const r = o as Record<string, unknown>;
      add(r.price);
      add(r.lowPrice);
      // Preço de lista, se vier (o "de" do "de/por").
      for (const spec of [r.priceSpecification].flat()) {
        if (!spec || typeof spec !== "object") continue;
        const sp = spec as Record<string, unknown>;
        if (/ListPrice/i.test(String(sp.priceType ?? ""))) add(sp.price, list);
      }
      if (r.offers) offerPrices(r.offers, depth + 1);
    }
  };
  const findProduct = (node: unknown, depth: number): boolean => {
    if (!node || typeof node !== "object" || depth > 4) return false;
    if (Array.isArray(node)) {
      return node.some((n) => findProduct(n, depth + 1));
    }
    const r = node as Record<string, unknown>;
    const types = [r["@type"]].flat().map(String);
    if (
      (types.includes("Product") || types.includes("ProductGroup")) &&
      r.offers
    ) {
      offerPrices(r.offers, 0);
      if (out.length > 0) return true;
    }
    if (types.includes("ProductGroup") && findProduct(r.hasVariant, depth + 1))
      return true;
    return findProduct(r["@graph"], depth + 1);
  };
  for (const text of ldTexts) {
    try {
      if (findProduct(JSON.parse(text), 0)) {
        return { values: out, list, from: "json-ld" };
      }
    } catch {
      /* JSON-LD quebrado: segue pro próximo */
    }
  }
  for (const v of metaValues) add(v);
  if (out.length > 0) return { values: out, list, from: "meta" };
  for (const entry of Array.isArray(layer) ? layer : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const ec = e.ecommerce as Record<string, unknown> | undefined;
    if (!ec || typeof ec !== "object") continue;
    const detail = ec.detail as Record<string, unknown> | undefined;
    const items =
      e.event === "view_item"
        ? ec.items
        : detail && typeof detail === "object"
          ? detail.products
          : null;
    if (!Array.isArray(items) || !items[0] || typeof items[0] !== "object")
      continue;
    add((items[0] as Record<string, unknown>).price);
    if (out.length > 0) return { values: out, list, from: "dataLayer" };
  }
  return { values: [], list: [], from: null };
}

/**
 * O texto mostra um destes valores no formato de dinheiro da página? 244.3
 * casa "R$ 244,30" e "$244.30"; 1299.9 casa "1.299,90"; 780 casa "R$ 780".
 * Não casa pedaço de outro número ("1.244,30", "24,43", "780,50").
 *
 * Cópia igual em `measurePdpInPage` (`const moneyHasValue = ...`).
 */
export function moneyHasValue(text: string, values: number[]): boolean {
  for (const v of values) {
    const cents = Math.round(v * 100);
    const digits = String(Math.floor(cents / 100));
    const dec = String(cents % 100).padStart(2, "0");
    const grouped = (sep: string): string =>
      digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    const forms = [
      `${grouped(".")},${dec}`,
      `${grouped(",")}.${dec}`,
      `${digits},${dec}`,
      `${digits}.${dec}`,
    ];
    if (cents % 100 === 0) forms.push(grouped("."), grouped(","), digits);
    for (const f of forms) {
      const esc = f.replace(/\./g, "\\.");
      if (new RegExp(`(^|[^\\d.,])${esc}(?![.,]?\\d)`).test(text)) return true;
    }
  }
  return false;
}

/**
 * Texto de botão de compra: curto, com verbo de compra, e não é favorito nem
 * lista ("Adicionar aos favoritos", "Adicionar à lista de desejos"; revisão,
 * 14/11). Cópia igual em `measurePdpInPage` (`const isBuyText = ...`).
 */
export function isBuyText(text: string): boolean {
  if (text.length > 40) return false;
  if (/(favorit|desejo|wishlist|lista)/i.test(text)) return false;
  return /(adicionar|comprar|sacola|carrinho|add to (bag|cart)|buy now|añadir|comprar agora)/i.test(
    text,
  );
}

/**
 * Quais textos mostram o preço desta peça: primeiro o de venda (`sale`) fora
 * de riscado; o de lista (`list`, o "de" riscado) só se nenhum mostrar o de
 * venda. Antes os dois valiam juntos e o riscado podia ganhar por estar mais
 * alto (revisão, 14/11). Devolve os índices.
 *
 * Cópia igual em `measurePdpInPage` (`const priceMatches = ...`).
 */
export function priceMatches(
  cands: Array<{ text: string; struck: boolean }>,
  sale: number[],
  list: number[],
  has: (text: string, values: number[]) => boolean,
): number[] {
  const out: number[] = [];
  cands.forEach((c, i) => {
    if (!c.struck && sale.length > 0 && has(c.text, sale)) out.push(i);
  });
  if (out.length > 0 || list.length === 0) return out;
  cands.forEach((c, i) => {
    if (has(c.text, list)) out.push(i);
  });
  return out;
}

/**
 * Índice do candidato mais alto na página (menor y) fora de barra fixa
 * (`pinned`), ou -1. Empate de altura (2px): `prefer` decide entre o menor
 * elemento (preço: o span do valor, não o bloco "de/por") e o maior (botão:
 * o clicável, não o texto de dentro).
 *
 * Cópia igual em `measurePdpInPage` (`const pickTopCandidate = ...`).
 */
export function pickTopCandidate(
  cands: Array<{ y: number; area: number; pinned: boolean }>,
  prefer: "small" | "large",
): number {
  let best = -1;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    if (c.pinned) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = cands[best]!;
    if (c.y < b.y - 2) best = i;
    else if (
      Math.abs(c.y - b.y) <= 2 &&
      (prefer === "small" ? c.area < b.area : c.area > b.area)
    )
      best = i;
  }
  return best;
}

// ── Medir a PDP ──────────────────────────────────────────────────────────────

export interface MeasuredPdp {
  page_height: number;
  positions: {
    price: number | null;
    size_selector: number | null;
    buy_button: number | null;
    shipping: number | null;
    first_recommendation: number | null;
  };
  /** Seletores dos elementos achados — o mockup usa pra saber onde mexer. */
  selectors: {
    price: string | null;
    size_selector: string | null;
    buy_button: string | null;
    shipping: string | null;
    first_recommendation: string | null;
  };
  has_sticky_buy: boolean;
  above_fold_outline: string[];
  sold_out_signal: boolean;
  /**
   * Depuração (sonda): quantos candidatos a preço e a botão de compra havia
   * e de onde veio o valor do preço ("fonte" = critério antigo, maior
   * fonte; 14/11).
   */
  candidates?: {
    price: number;
    price_from: "json-ld" | "meta" | "dataLayer" | "fonte";
    buy_button: number;
  };
}

/**
 * Onde estão preço, tamanho, botão de compra, frete e a primeira recomendação
 * (px do topo do documento), se existe barra de compra fixa, e o que aparece na
 * primeira tela. Precisa da página já rolada uma vez (lazy-load).
 */
export async function measurePdpInPage(opts?: {
  /**
   * Não rola a página (a sonda da barra fixa vai a 60% e volta): o teste ao
   * vivo mede de novo sem mexer no estado sob teste — rolar dispara pop-up de
   * scroll e lazy-load (revisão, 14/11). `has_sticky_buy` sai false.
   */
  skipScroll?: boolean;
}): Promise<MeasuredPdp> {
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return (
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      Number(s.opacity) > 0.05
    );
  };
  // Posição no documento = topo na tela + a rolagem de quem rola a página
  // (a janela ou o <body>, numa loja; 14/11). Mesmo corpo de `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const scroller = pageScroller();
  const scrollOf = (el: Element): number =>
    window.scrollY + (scroller?.contains(el) ? scroller.scrollTop : 0);
  const top = (el: Element): number =>
    Math.round(el.getBoundingClientRect().top + scrollOf(el));
  // Rola pelo mesmo caminho de `scrollPageToInPage`.
  const scrollPage = (y: number): void => {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    scroller?.scrollTo({
      top: Math.max(0, y - window.scrollY),
      left: 0,
      behavior: "instant",
    });
  };
  // Texto visível, sem o conteúdo de SCRIPT/STYLE/NOSCRIPT/TEMPLATE: sites
  // TanStack embutem o JSON do evento de analytics DENTRO do botão, e o
  // textContent de "Adicionar à sacola" passava de 40 caracteres (14/11).
  // Mesmo corpo de `visibleTextOf` (testado fora do navegador).
  const visibleText = (node: Node): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // Com :nth-of-type quando o caminho curto casa primeiro com outro
  // elemento: o preço de uma loja é o 2º <span> do "de/por", e o seletor sem
  // posição apontava pro "R$ 349,00" riscado (14/11).
  const cssPath = (el: Element): string => {
    const build = (nth: boolean): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; node && depth < 4; depth++) {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
          parts.unshift(`#${node.id}`);
          break;
        }
        const classes = Array.from(node.classList)
          .filter((c) => /^[A-Za-z][\w-]*$/.test(c))
          .slice(0, 2);
        let part =
          node.tagName.toLowerCase() + classes.map((c) => `.${c}`).join("");
        const parent: Element | null = node.parentElement;
        const cur: Element = node;
        if (nth && parent) {
          const same = Array.from(parent.children).filter(
            (k) => k.localName === cur.localName,
          );
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };
    const short = build(false);
    try {
      if (document.querySelector(short) === el) return short;
    } catch {
      /* classe com caractere que o seletor não aceita: vai com posição */
    }
    return build(true);
  };

  const all = Array.from(document.querySelectorAll("body *")).filter(visible);

  // Fora de barra fixa: ancestral `fixed`, ou `sticky` do tamanho de uma
  // barra (menos de meia tela). A foto de uma loja é um `sticky` da altura da
  // tela com nome, preço e "comprar" por cima, e isso é a primeira tela, não
  // barra (14/11). Cabeçalho/menu também não é o produto.
  // Cabeçalho do SITE: o header/nav visível mais alto fora de main/article
  // (e o header que o contém). <header> semântico dentro do bloco do
  // produto não conta (revisão, 14/11).
  let siteHeader: Element | null = null;
  for (const h of Array.from(
    document.querySelectorAll(
      "header, nav, [role='banner'], [role='navigation']",
    ),
  )) {
    if (!visible(h) || h.closest("main, article, [role='main']")) continue;
    if (!siteHeader || top(h) < top(siteHeader)) siteHeader = h;
  }
  if (siteHeader)
    siteHeader = siteHeader.closest("header, [role='banner']") ?? siteHeader;
  const pinned = (el: Element): boolean => {
    if (siteHeader?.contains(el)) return true;
    for (
      let n: Element | null = el;
      n && n !== document.body;
      n = n.parentElement
    ) {
      const pos = getComputedStyle(n).position;
      if (pos === "fixed") return true;
      if (
        pos === "sticky" &&
        n.getBoundingClientRect().height < window.innerHeight * 0.5
      )
        return true;
    }
    return false;
  };
  // Na tela na horizontal: carrossel esconde card fora dela (o "leve o look"
  // de uma loja tem "R$" em x=1758, y=405; 14/11).
  const onScreenX = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.left < window.innerWidth;
  };
  // Mesmos corpos de `productPriceValues`, `moneyHasValue`,
  // `pickTopCandidate`, `isBuyText` e `priceMatches` (testados fora do
  // navegador).
  const isBuyText = (text: string): boolean => {
    if (text.length > 40) return false;
    if (/(favorit|desejo|wishlist|lista)/i.test(text)) return false;
    return /(adicionar|comprar|sacola|carrinho|add to (bag|cart)|buy now|añadir|comprar agora)/i.test(
      text,
    );
  };
  const priceMatches = (
    cands: Array<{ text: string; struck: boolean }>,
    sale: number[],
    list: number[],
    has: (text: string, values: number[]) => boolean,
  ): number[] => {
    const out: number[] = [];
    cands.forEach((c, i) => {
      if (!c.struck && sale.length > 0 && has(c.text, sale)) out.push(i);
    });
    if (out.length > 0 || list.length === 0) return out;
    cands.forEach((c, i) => {
      if (has(c.text, list)) out.push(i);
    });
    return out;
  };
  const productPriceValues = (
    ldTexts: string[],
    metaValues: string[],
    layer: unknown,
  ): {
    values: number[];
    list: number[];
    from: "json-ld" | "meta" | "dataLayer" | null;
  } => {
    const out: number[] = [];
    // Preço de lista (o "de" riscado) à parte: só vale se o de venda não
    // aparecer em lugar nenhum (revisão, 14/11).
    const list: number[] = [];
    const add = (v: unknown, into: number[] = out): void => {
      let n = Number.NaN;
      if (typeof v === "number") n = v;
      else if (typeof v === "string") {
        const t = v.replace(/[^\d.,]/g, "");
        // "1.998" é milhar, não decimal: ponto seguido de 3 dígitos no fim
        // (revisão, 14/11).
        n = Number.parseFloat(
          /,\d{1,2}$/.test(t)
            ? t.replace(/\./g, "").replace(",", ".")
            : /\.\d{3}$/.test(t)
              ? t.replace(/[.,]/g, "")
              : t.replace(/,/g, ""),
        );
      }
      if (Number.isFinite(n) && n > 0 && !into.includes(n)) into.push(n);
    };
    const offerPrices = (offers: unknown, depth: number): void => {
      if (depth > 3) return;
      for (const o of Array.isArray(offers) ? offers : [offers]) {
        if (!o || typeof o !== "object") continue;
        const r = o as Record<string, unknown>;
        add(r.price);
        add(r.lowPrice);
        // Preço de lista, se vier (o "de" do "de/por").
        for (const spec of [r.priceSpecification].flat()) {
          if (!spec || typeof spec !== "object") continue;
          const sp = spec as Record<string, unknown>;
          if (/ListPrice/i.test(String(sp.priceType ?? "")))
            add(sp.price, list);
        }
        if (r.offers) offerPrices(r.offers, depth + 1);
      }
    };
    const findProduct = (node: unknown, depth: number): boolean => {
      if (!node || typeof node !== "object" || depth > 4) return false;
      if (Array.isArray(node)) {
        return node.some((n) => findProduct(n, depth + 1));
      }
      const r = node as Record<string, unknown>;
      const types = [r["@type"]].flat().map(String);
      if (
        (types.includes("Product") || types.includes("ProductGroup")) &&
        r.offers
      ) {
        offerPrices(r.offers, 0);
        if (out.length > 0) return true;
      }
      if (
        types.includes("ProductGroup") &&
        findProduct(r.hasVariant, depth + 1)
      )
        return true;
      return findProduct(r["@graph"], depth + 1);
    };
    for (const text of ldTexts) {
      try {
        if (findProduct(JSON.parse(text), 0)) {
          return { values: out, list, from: "json-ld" };
        }
      } catch {
        /* JSON-LD quebrado: segue pro próximo */
      }
    }
    for (const v of metaValues) add(v);
    if (out.length > 0) return { values: out, list, from: "meta" };
    for (const entry of Array.isArray(layer) ? layer : []) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const ec = e.ecommerce as Record<string, unknown> | undefined;
      if (!ec || typeof ec !== "object") continue;
      const detail = ec.detail as Record<string, unknown> | undefined;
      const items =
        e.event === "view_item"
          ? ec.items
          : detail && typeof detail === "object"
            ? detail.products
            : null;
      if (!Array.isArray(items) || !items[0] || typeof items[0] !== "object")
        continue;
      add((items[0] as Record<string, unknown>).price);
      if (out.length > 0) return { values: out, list, from: "dataLayer" };
    }
    return { values: [], list: [], from: null };
  };
  const moneyHasValue = (text: string, values: number[]): boolean => {
    for (const v of values) {
      const cents = Math.round(v * 100);
      const digits = String(Math.floor(cents / 100));
      const dec = String(cents % 100).padStart(2, "0");
      const grouped = (sep: string): string =>
        digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
      const forms = [
        `${grouped(".")},${dec}`,
        `${grouped(",")}.${dec}`,
        `${digits},${dec}`,
        `${digits}.${dec}`,
      ];
      if (cents % 100 === 0) forms.push(grouped("."), grouped(","), digits);
      for (const f of forms) {
        const esc = f.replace(/\./g, "\\.");
        if (new RegExp(`(^|[^\\d.,])${esc}(?![.,]?\\d)`).test(text))
          return true;
      }
    }
    return false;
  };
  const pickTopCandidate = (
    cands: Array<{ y: number; area: number; pinned: boolean }>,
    prefer: "small" | "large",
  ): number => {
    let best = -1;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]!;
      if (c.pinned) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const b = cands[best]!;
      if (c.y < b.y - 2) best = i;
      else if (
        Math.abs(c.y - b.y) <= 2 &&
        (prefer === "small" ? c.area < b.area : c.area > b.area)
      )
        best = i;
    }
    return best;
  };

  // Preço: o preço DESTE produto (JSON-LD, meta, view_item) no formato da
  // página, e vale o mais alto visível fora de barra fixa. Escolher pela
  // maior fonte pegava o preço da folha de baixo de uma loja (y=938) e
  // ignorava o da foto, na primeira tela (14/11). Sem valor declarado, ou
  // sem texto que o mostre, fica o critério antigo (maior fonte na metade
  // de cima).
  const money = /(R\$|US\$|\$|€|£)\s?\d/;
  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    scroller ? scroller.scrollHeight : 0,
  );
  const declared = productPriceValues(
    Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).map((el) => (el as HTMLScriptElement).text),
    Array.from(
      document.querySelectorAll(
        "[itemprop='price'], meta[property='product:price:amount'], meta[property='og:price:amount']",
      ),
    ).map((el) => el.getAttribute("content") ?? visibleText(el)),
    (window as unknown as { dataLayer?: unknown }).dataLayer,
  );
  // Riscado: o "de" do "de/por" (line-through, ou dentro de <s>/<del>).
  const struck = (el: Element): boolean => {
    if (el.closest("s, del, strike")) return true;
    let n: Element | null = el;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      if (/line-through/.test(getComputedStyle(n).textDecorationLine))
        return true;
    }
    return false;
  };
  const moneyEls: Element[] = [];
  if (declared.values.length > 0 || declared.list.length > 0) {
    for (const el of all) {
      if (el.children.length > 2) continue;
      const t = visibleText(el);
      if (t.length > 40 || !money.test(t) || !onScreenX(el)) continue;
      moneyEls.push(el);
    }
  }
  const priceCands = priceMatches(
    moneyEls.map((el) => ({ text: visibleText(el), struck: struck(el) })),
    declared.values,
    declared.list,
    moneyHasValue,
  ).map((i) => moneyEls[i]!);
  // O mais de dentro: o bloco "nome + preço" da foto de uma loja (y=671) também
  // mostra o valor e ficava acima do <span> do preço (14/11).
  const innerPrice = priceCands.filter(
    (el) => !priceCands.some((o) => o !== el && el.contains(o)),
  );
  let price: Element | null =
    innerPrice[
      pickTopCandidate(
        innerPrice.map((el) => {
          const r = el.getBoundingClientRect();
          return { y: top(el), area: r.width * r.height, pinned: pinned(el) };
        }),
        "small",
      )
    ] ?? null;
  const priceFrom = price ? (declared.from ?? "fonte") : "fonte";
  if (!price) {
    let priceSize = 0;
    for (const el of all) {
      if (el.children.length > 2) continue;
      const t = visibleText(el);
      if (t.length > 40 || !money.test(t)) continue;
      if (top(el) > pageHeight * 0.5) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize) || 0;
      if (size > priceSize) {
        price = el;
        priceSize = size;
      }
    }
  }

  // Botão de compra: o mais alto visível fora de barra fixa (a barra tem a
  // sonda dela). Candidatos: button/a/[role=button] e o que tem cursor
  // pointer ou onclick (o "comprar" da foto de uma loja é um <label>), com texto
  // curto de compra e pelo menos 60×28. Escolher o maior pegava o
  // #add-to-cart-button da folha de baixo (y=1304; 14/11).
  const semantic = (el: Element): boolean =>
    el.localName === "button" ||
    el.localName === "a" ||
    el.getAttribute("role") === "button";
  const rawBuy: Element[] = [];
  for (const el of all) {
    if (!isBuyText(visibleText(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 28 || !onScreenX(el)) continue;
    if (!semantic(el)) {
      const cursor = getComputedStyle(el).cursor;
      const handler =
        el.hasAttribute("onclick") ||
        typeof (el as HTMLElement).onclick === "function";
      if (cursor !== "pointer" && !handler) continue;
    }
    rawBuy.push(el);
  }
  // Aninhados: o semântico vence o de cursor (cursor pointer é herdado), e
  // entre dois de cursor fica o de fora.
  const buyCands = rawBuy.filter(
    (el) =>
      !rawBuy.some(
        (o) =>
          o !== el &&
          ((o.contains(el) && (semantic(o) || !semantic(el))) ||
            (el.contains(o) && semantic(o) && !semantic(el))),
      ),
  );
  let buy: Element | null =
    buyCands[
      pickTopCandidate(
        buyCands.map((el) => {
          const r = el.getBoundingClientRect();
          return { y: top(el), area: r.width * r.height, pinned: pinned(el) };
        }),
        "large",
      )
    ] ?? null;
  // Só barra fixa com botão: o critério antigo (o maior botão de compra),
  // pra não dizer que não há botão.
  if (!buy) {
    let buyArea = 0;
    for (const el of rawBuy) {
      if (!semantic(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > buyArea) {
        buy = el;
        buyArea = r.width * r.height;
      }
    }
  }

  // Seletor de tamanho: 3+ irmãos cujo texto é um tamanho.
  const sizeToken =
    /^(PP|P|M|G|GG|XG|XGG|XS|S|L|XL|XXL|U|UN|ÚNICO|UNICO|\d{2}|\d{1,2}(\.5)?)$/i;
  let sizes: Element | null = null;
  for (const el of all) {
    const kids = Array.from(el.children).filter(visible);
    if (kids.length < 3 || kids.length > 15) continue;
    const hits = kids.filter((k) => sizeToken.test(visibleText(k))).length;
    if (hits >= 3 && hits >= kids.length * 0.6) {
      if (!sizes || top(el) < top(sizes)) sizes = el;
    }
  }

  // Frete: campo de CEP ou texto de entrega perto do produto. Entre os
  // candidatos vale o mais perto do botão de compra (ou do preço): a barra
  // de promoção do topo de uma loja gira "frete grátis" e, quando o slide
  // estava visível, virava o frete em y=2 (14/11).
  const near = buy ?? price;
  const nearest = (els: Element[]): Element | null => {
    if (!near || els.length < 2) return els[0] ?? null;
    const y = top(near);
    return els.reduce((a, b) =>
      Math.abs(top(b) - y) < Math.abs(top(a) - y) ? b : a,
    );
  };
  let shipping: Element | null = nearest(
    Array.from(document.querySelectorAll("input"))
      .filter(visible)
      .filter((el) =>
        /(cep|frete|entrega|postal|zip|shipping)/i.test(
          `${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("name") ?? ""} ${el.getAttribute("aria-label") ?? ""}`,
        ),
      ),
  );
  // O texto tem que ser curto e o elemento folha (ou só com filhos em linha):
  // sem isso o `<main>` de uma loja, com 1 filho e "frete grátis" no meio
  // de tudo, virou o frete em y=0 (14/11).
  if (!shipping) {
    const texts: Element[] = [];
    for (const el of all) {
      if (/^(html|body|main|section|article)$/.test(el.localName)) continue;
      if (el.children.length > 3) continue;
      const t = visibleText(el);
      if (
        t.length > 80 ||
        !/(calcul\w* (o )?frete|prazo de entrega|frete grátis|estimated delivery)/i.test(
          t,
        )
      )
        continue;
      const blockKid = Array.from(el.children).some(
        (k) => !/^(inline|contents|none)/.test(getComputedStyle(k).display),
      );
      if (!blockKid) texts.push(el);
    }
    shipping = nearest(texts);
  }

  // Primeira recomendação: título de vitrine abaixo do botão de compra. As
  // palavras cobrem os títulos reais de uma loja ("Complete seu look",
  // "Quem comprou também curtiu", 14/11).
  const recoWords =
    /(voc[eê] tamb[eé]m|vo[cç][eê] (tamb[eé]m )?(pode|vai) gostar|compre junto|complete (o|seu) look|leve tamb[eé]m|leve o look|quem comprou|quem viu|recomend|you may also|similar|combin[ae] com|combina|aproveite tamb[eé]m|outras cores|veja tamb[eé]m)/i;
  let reco: Element | null = null;
  const buyTop = buy ? top(buy) : 0;
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (
      !/^h[1-6]$/.test(tag) &&
      !(el.children.length === 0 && visibleText(el).length < 40)
    )
      continue;
    if (!recoWords.test(visibleText(el))) continue;
    if (top(el) <= buyTop) continue;
    if (!reco || top(el) < top(reco)) reco = el;
  }
  // Sem título que case: o primeiro bloco abaixo do botão de compra com 3+
  // cards distintos de produto (`/p` no fim do caminho) é vitrine.
  if (!reco && buy) {
    const productPath = (a: HTMLAnchorElement): string | null => {
      try {
        const u = new URL(a.href, location.href);
        if (u.origin !== location.origin || !/\/p\/?$/.test(u.pathname))
          return null;
        return u.pathname === location.pathname ? null : u.pathname;
      } catch {
        return null;
      }
    };
    // Só link de card: com foto de 80px+ dentro. Bolinha de cor também
    // aponta pra outro /p e não é vitrine (revisão, 14/11).
    const cardPath = (a: HTMLAnchorElement): string | null =>
      Array.from(a.querySelectorAll("img")).some(
        (img) => img.getBoundingClientRect().width >= 80,
      )
        ? productPath(a)
        : null;
    const links = (
      Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]
    )
      .filter((a) => visible(a) && top(a) > buyTop && cardPath(a))
      .sort((a, b) => top(a) - top(b));
    const counted = new Map<Element, number>();
    const distinct = (block: Element): number => {
      let n = counted.get(block);
      if (n === undefined) {
        n = new Set(
          (Array.from(block.querySelectorAll("a[href]")) as HTMLAnchorElement[])
            .map(cardPath)
            .filter(Boolean),
        ).size;
        counted.set(block, n);
      }
      return n;
    };
    for (const a of links) {
      let found: Element | null = null;
      for (
        let block = a.parentElement, depth = 0;
        block && depth < 8 && !/^(html|body|main)$/.test(block.localName);
        block = block.parentElement, depth++
      ) {
        if (distinct(block) >= 3) {
          found = block;
          break;
        }
      }
      if (found && top(found) > buyTop) {
        reco = found;
        break;
      }
    }
  }

  // Barra fixa: rola até 60% da página e procura botão de compra visível
  // dentro de um ancestral fixed/sticky. Com `skipScroll`, não sonda.
  let sticky = false;
  if (!opts?.skipScroll) {
    scrollPage(Math.floor(pageHeight * 0.6));
    await new Promise((r) => setTimeout(r, 400));
    for (const el of Array.from(
      document.querySelectorAll("button, a, [role='button']"),
    )) {
      if (!visible(el) || !isBuyText(visibleText(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      let node: Element | null = el;
      while (node && node !== document.body) {
        const pos = getComputedStyle(node).position;
        if (pos === "fixed" || pos === "sticky") {
          sticky = true;
          break;
        }
        node = node.parentElement;
      }
      if (sticky) break;
    }
    scrollPage(0);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Rótulo pra exibir: sem sub-árvore escondida (tooltip). Mesmo corpo de
  // `labelTextOf` (revisão, 14/11).
  const hiddenNode = (n: TextTreeNode): boolean => {
    const st = getComputedStyle(n as unknown as Element);
    return st.display === "none" || st.visibility === "hidden";
  };
  const labelText = (
    node: TextTreeNode,
    hidden: (n: TextTreeNode) => boolean,
  ): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      if (hidden(n)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // O que está na primeira tela, em ordem, em texto curto.
  const outline: string[] = [];
  const seen = new Set<string>();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight) continue;
    const tag = el.tagName.toLowerCase();
    const isLeaf = el.children.length === 0;
    if (tag === "img" && r.width * r.height > window.innerWidth * 120) {
      // Carrossel empilha N fotos no mesmo lugar; uma linha basta.
      const line = `[imagem ${Math.round(r.width)}×${Math.round(r.height)} em y=${Math.round(r.top)}]`;
      if (!seen.has(line)) {
        seen.add(line);
        outline.push(line);
      }
      continue;
    }
    if (!isLeaf && !/^(button|h[1-6]|a|label)$/.test(tag)) continue;
    const t = labelText(el, hiddenNode);
    if (!t || t.length > 60 || seen.has(t)) continue;
    seen.add(t);
    outline.push(`${tag} "${t}" em y=${Math.round(r.top)}`);
    if (outline.length >= 30) break;
  }

  const bodyText = visibleText(document.body).slice(0, 20_000);
  const soldOut = /(esgotad|indispon[ií]vel|sold out|avise-me|me avise)/i.test(
    bodyText,
  );

  return {
    page_height: pageHeight,
    positions: {
      price: price ? top(price) : null,
      size_selector: sizes ? top(sizes) : null,
      buy_button: buy ? top(buy) : null,
      shipping: shipping ? top(shipping) : null,
      first_recommendation: reco ? top(reco) : null,
    },
    selectors: {
      price: price ? cssPath(price) : null,
      size_selector: sizes ? cssPath(sizes) : null,
      buy_button: buy ? cssPath(buy) : null,
      shipping: shipping ? cssPath(shipping) : null,
      first_recommendation: reco ? cssPath(reco) : null,
    },
    has_sticky_buy: sticky,
    above_fold_outline: outline,
    sold_out_signal: soldOut,
    candidates: {
      price: priceCands.length,
      price_from: priceFrom,
      buy_button: buyCands.length,
    },
  };
}

/** Medidas de uma página fora da PDP (home, categoria, busca). */
export interface MeasuredSitePage {
  page_height: number;
  /** Partes da página (px do topo do documento). NULL = não achou. */
  positions: Record<string, number | null>;
  selectors: Record<string, string | null>;
  above_fold_outline: string[];
  /** Números e sim/não da página (cards na 1ª tela, total de resultados…). */
  facts: Record<string, number | boolean | string | null>;
}

/**
 * Mede home, categoria ou busca: onde ficam o destaque, a primeira vitrine,
 * o primeiro card, filtro, ordenar, busca e menu, e os fatos que decidem se a
 * cliente acha o produto (quantos cards na primeira tela, quantos por linha, o
 * que o card mostra, total de resultados, se a busca voltou vazia).
 *
 * Card de produto = link pra PDP pelo padrão da URL (`/p`, `/produto/`…) com
 * foto; o card é o ancestral mais próximo que parece item de lista. Tudo é
 * heurística sobre o DOM de uma loja qualquer: o que não achar volta null.
 */
export async function measureSitePageInPage(
  kind: "home" | "categoria" | "busca",
  opts?: { skipScroll?: boolean },
): Promise<MeasuredSitePage> {
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return (
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      Number(s.opacity) > 0.05
    );
  };
  // Posição no documento = topo na tela + a rolagem de quem rola a página
  // (a janela ou o <body>, numa loja; 14/11). Mesmo corpo de `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const scroller = pageScroller();
  const scrollOf = (el: Element): number =>
    window.scrollY + (scroller?.contains(el) ? scroller.scrollTop : 0);
  const top = (el: Element): number =>
    Math.round(el.getBoundingClientRect().top + scrollOf(el));
  // Rola pelo mesmo caminho de `scrollPageToInPage`.
  const scrollPage = (y: number): void => {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    scroller?.scrollTo({
      top: Math.max(0, y - window.scrollY),
      left: 0,
      behavior: "instant",
    });
  };
  // Texto visível, sem o conteúdo de SCRIPT/STYLE/NOSCRIPT/TEMPLATE: sites
  // TanStack embutem o JSON do evento de analytics DENTRO do botão, e o
  // textContent de "Adicionar à sacola" passava de 40 caracteres (14/11).
  // Mesmo corpo de `visibleTextOf` (testado fora do navegador).
  const visibleText = (node: Node): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // Com :nth-of-type quando o caminho curto casa primeiro com outro
  // elemento: o preço de uma loja é o 2º <span> do "de/por", e o seletor sem
  // posição apontava pro "R$ 349,00" riscado (14/11).
  const cssPath = (el: Element): string => {
    const build = (nth: boolean): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; node && depth < 4; depth++) {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
          parts.unshift(`#${node.id}`);
          break;
        }
        const classes = Array.from(node.classList)
          .filter((c) => /^[A-Za-z][\w-]*$/.test(c))
          .slice(0, 2);
        let part =
          node.tagName.toLowerCase() + classes.map((c) => `.${c}`).join("");
        const parent: Element | null = node.parentElement;
        const cur: Element = node;
        if (nth && parent) {
          const same = Array.from(parent.children).filter(
            (k) => k.localName === cur.localName,
          );
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };
    const short = build(false);
    try {
      if (document.querySelector(short) === el) return short;
    } catch {
      /* classe com caractere que o seletor não aceita: vai com posição */
    }
    return build(true);
  };
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
    scroller?.scrollHeight ?? 0,
  );
  const all = Array.from(document.querySelectorAll("body *")).filter(visible);
  const isPinned = (el: Element): boolean => {
    for (
      let n: Element | null = el;
      n && n !== document.body;
      n = n.parentElement
    ) {
      const pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  };
  const firstByText = (re: RegExp, max = 40): Element | null => {
    let best: Element | null = null;
    for (const el of Array.from(
      document.querySelectorAll(
        "button, a, summary, label, [role='button'], select",
      ),
    )) {
      if (!visible(el)) continue;
      const t = (
        visibleText(el) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        ""
      ).trim();
      if (!t || t.length > max || !re.test(t)) continue;
      if (!best || top(el) < top(best)) best = el;
    }
    return best;
  };

  // Cards de produto: link pra PDP com foto, um por produto.
  const pdpPattern =
    /(\/p$|\/p\/|\/product\/|\/produto\/|^(\/[a-z]{2}(-[a-z]{2})?)?\/products\/[^/]+\/?$|\/collections\/[^/]+\/products\/[^/]+|\/prd\/|-p-\d|-p\d{6,}\.html$|\/dp\/|\/item\/)/i;
  const cards: Element[] = [];
  const seenHref = new Set<string>();
  for (const a of Array.from(
    document.querySelectorAll("a[href]"),
  ) as HTMLAnchorElement[]) {
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      continue;
    }
    if (url.origin !== location.origin || !pdpPattern.test(url.pathname))
      continue;
    // O card é o menor ancestral com foto e preço (até 6 níveis): numa loja
    // o link mais próximo de um <li> era o slide da foto, sem preço. Sem
    // preço à vista, o item de lista mais próximo.
    let card: Element | null = null;
    for (
      let n: Element | null = a, depth = 0;
      n && n !== document.body && depth < 7;
      n = n.parentElement, depth++
    ) {
      if (n.getBoundingClientRect().width > vw * 0.95) break;
      if (
        n.querySelector("img, picture, video") &&
        /R\$\s?\d|\$\s?\d/.test(visibleText(n))
      ) {
        card = n;
        break;
      }
    }
    card ??=
      a.closest("article, li, [class*='card' i], [class*='product-item' i]") ??
      a;
    if (!visible(card) || !card.querySelector("img, picture, video")) continue;
    const r = card.getBoundingClientRect();
    if (r.width < 60 || r.width > vw * 0.95 || r.height < 80) continue;
    if (seenHref.has(url.pathname) || cards.includes(card)) continue;
    seenHref.add(url.pathname);
    cards.push(card);
  }
  cards.sort(
    (a, b) =>
      top(a) - top(b) ||
      a.getBoundingClientRect().left - b.getBoundingClientRect().left,
  );
  // Card escondido num carrossel (fora da tela na horizontal) não conta na
  // primeira tela nem na linha.
  const onScreenX = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.left < vw;
  };
  const firstCard = cards.find(onScreenX) ?? cards[0] ?? null;
  const firstTop = firstCard ? top(firstCard) : null;
  const perRow =
    firstCard && firstTop != null
      ? cards.filter((c) => onScreenX(c) && Math.abs(top(c) - firstTop) < 12)
          .length
      : null;
  const aboveFold = cards.filter(
    (c) => onScreenX(c) && top(c) + c.getBoundingClientRect().height * 0.5 < vh,
  ).length;
  const sample = cards.slice(0, 4);
  const someCard = (test: (c: Element) => boolean): boolean | null =>
    sample.length === 0 ? null : sample.some(test);
  // Vitrine = o ancestral mais próximo de um card que junta 3+ cards.
  const shelfOf = (c: Element): Element | null => {
    for (
      let n: Element | null = c.parentElement, depth = 0;
      n && n !== document.body && depth < 6;
      n = n.parentElement, depth++
    ) {
      let inside = 0;
      for (const other of cards) if (n.contains(other)) inside++;
      if (inside >= 3) return n;
    }
    return null;
  };
  const shelves = new Set(
    cards.map(shelfOf).filter((n): n is Element => n !== null),
  ).size;

  // Partes.
  const searchField =
    Array.from(
      document.querySelectorAll(
        "input[type='search'], input[name='q'], input[name*='search' i], input[placeholder*='busc' i], input[placeholder*='search' i], input[placeholder*='procur' i]",
      ),
    ).find(visible) ?? null;
  const searchEntry =
    searchField ??
    firstByText(/(busca|buscar|pesquis|search|procur)/i, 25) ??
    Array.from(
      document.querySelectorAll(
        "[aria-label*='busca' i], [aria-label*='search' i], [aria-label*='pesquis' i]",
      ),
    ).find(visible) ??
    null;
  const menuButton =
    Array.from(
      document.querySelectorAll(
        "[aria-label*='menu' i], button[class*='menu' i], [class*='hamburger' i]",
      ),
    ).find(visible) ?? firstByText(/\bmenu\b/i, 25);
  const filterButton = firstByText(/^(filtr|filter|refinar)/i);
  const sortButton = firstByText(/(ordenar|ordem|classificar|sort)/i);
  const loadMore =
    firstByText(
      /(carregar mais|ver mais produtos|mostrar mais|load more|próxima|proxima|next)/i,
    ) ??
    Array.from(document.querySelectorAll("a[rel='next']")).find(visible) ??
    null;
  const h1 = Array.from(document.querySelectorAll("h1")).find(visible) ?? null;
  let hero: Element | null = null;
  if (kind === "home") {
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (!/^(img|picture|video)$/.test(tag)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.85 || r.height < 120) continue;
      if (top(el) > vh * 1.2) continue;
      if (cards.some((c) => c.contains(el))) continue;
      hero = el;
      break;
    }
  }
  let firstShelf: Element | null = null;
  if (firstCard) {
    // O título da vitrine, se houver um logo acima do primeiro card.
    let heading: Element | null = null;
    for (const h of Array.from(document.querySelectorAll("h2, h3, h4"))) {
      if (!visible(h)) continue;
      const d = (firstTop ?? 0) - top(h);
      if (d >= 0 && d < 220 && (!heading || top(h) > top(heading))) heading = h;
    }
    firstShelf = heading ?? firstCard;
  }

  const bodyText = visibleText(document.body).slice(0, 30_000);
  const totalMatch = bodyText.match(
    /(\d{1,3}(?:[.,]\d{3})*|\d+)\s+(produtos?|resultados?|itens|items|results?|peças)\b/i,
  );
  // Só conta "nenhum resultado" sem card na página: uma loja deixa o texto do
  // estado vazio no DOM mesmo com 970 resultados (16/11).
  const noResults =
    cards.length === 0 &&
    /(nenhum (produto|resultado)|não encontramos|nao encontramos|0 (produtos|resultados)|sem resultados|no results|não achamos)/i.test(
      bodyText,
    );
  const countRe =
    /(\d{1,3}(?:[.,]\d{3})*|\d+)\s+(produtos?|resultados?|itens|items|results?|peças)\b/i;
  let resultsEl: Element | null = null;
  for (const el of all) {
    if (!/^(p|span|h1|h2|h3|div|strong|small)$/i.test(el.tagName)) continue;
    if (el.children.length > 2) continue;
    const t = visibleText(el);
    if (t.length > 80 || !countRe.test(t)) continue;
    if (!resultsEl || top(el) < top(resultsEl)) resultsEl = el;
  }

  // Filtro fixo ao rolar: rola a metade e vê se o botão continua na tela.
  let stickyFilter: boolean | null = null;
  let stickyHeader: boolean | null = null;
  if (!opts?.skipScroll) {
    scrollPage(Math.floor(pageHeight * 0.5));
    await new Promise((r) => setTimeout(r, 400));
    if (kind !== "home") {
      const f = firstByText(/^(filtr|filter|refinar)/i);
      stickyFilter = f
        ? (() => {
            const r = f.getBoundingClientRect();
            return r.bottom > 0 && r.top < vh && isPinned(f);
          })()
        : false;
    }
    const header = Array.from(
      document.querySelectorAll("header, [role='banner']"),
    ).find(visible);
    stickyHeader = header
      ? header.getBoundingClientRect().top < 5 &&
        header.getBoundingClientRect().bottom > 0
      : false;
    scrollPage(0);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Rótulo pra exibir: sem sub-árvore escondida (tooltip). Mesmo corpo de
  // `labelTextOf` (revisão, 14/11).
  const hiddenNode = (n: TextTreeNode): boolean => {
    const st = getComputedStyle(n as unknown as Element);
    return st.display === "none" || st.visibility === "hidden";
  };
  const labelText = (
    node: TextTreeNode,
    hidden: (n: TextTreeNode) => boolean,
  ): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      if (hidden(n)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // O que está na primeira tela, em ordem, em texto curto.
  const outline: string[] = [];
  const seen = new Set<string>();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight) continue;
    const tag = el.tagName.toLowerCase();
    const isLeaf = el.children.length === 0;
    if (tag === "img" && r.width * r.height > window.innerWidth * 120) {
      // Carrossel empilha N fotos no mesmo lugar; uma linha basta.
      const line = `[imagem ${Math.round(r.width)}×${Math.round(r.height)} em y=${Math.round(r.top)}]`;
      if (!seen.has(line)) {
        seen.add(line);
        outline.push(line);
      }
      continue;
    }
    if (!isLeaf && !/^(button|h[1-6]|a|label)$/.test(tag)) continue;
    const t = labelText(el, hiddenNode);
    if (!t || t.length > 60 || seen.has(t)) continue;
    seen.add(t);
    outline.push(`${tag} "${t}" em y=${Math.round(r.top)}`);
    if (outline.length >= 30) break;
  }

  const at = (el: Element | null | undefined): number | null =>
    el ? top(el) : null;
  const sel = (el: Element | null | undefined): string | null =>
    el ? cssPath(el) : null;
  const parts: Record<string, Element | null | undefined> =
    kind === "home"
      ? {
          hero,
          first_shelf: firstShelf,
          first_product: firstCard,
          search_entry: searchEntry,
          menu_button: menuButton,
        }
      : kind === "categoria"
        ? {
            page_title: h1,
            filter_button: filterButton,
            sort_button: sortButton,
            first_card: firstCard,
            load_more: loadMore,
          }
        : {
            search_field: searchField ?? searchEntry,
            results_count: resultsEl,
            filter_button: filterButton,
            sort_button: sortButton,
            first_card: firstCard,
          };
  const positions: Record<string, number | null> = {};
  const selectors: Record<string, string | null> = {};
  for (const [k, el] of Object.entries(parts)) {
    positions[k] = at(el);
    selectors[k] = sel(el);
  }
  const isSwatch = (n: Element): boolean => {
    const r = n.getBoundingClientRect();
    if (r.width < 6 || r.width > 30 || r.height < 6 || r.height > 30)
      return false;
    const st = getComputedStyle(n);
    return (
      parseFloat(st.borderRadius) >= r.width / 3 ||
      /color|cor|swatch/i.test(n.getAttribute("class") ?? "")
    );
  };
  const facts: MeasuredSitePage["facts"] = {
    cards_total: cards.length,
    cards_above_fold: aboveFold,
    cards_per_row: perRow,
    card_has_price: someCard((c) => /R\$\s?\d|\$\s?\d/.test(visibleText(c))),
    card_has_installments: someCard((c) => /\d+\s?x\s/i.test(visibleText(c))),
    card_has_swatches: someCard(
      (c) => Array.from(c.querySelectorAll("*")).filter(isSwatch).length >= 2,
    ),
    card_has_badge: someCard((c) =>
      /(\d+\s?%|\boff\b|novo|new|lançamento|exclusiv|últimas)/i.test(
        visibleText(c),
      ),
    ),
    card_has_buy: someCard((c) =>
      /(adicionar|comprar|sacola|add to (bag|cart))/i.test(visibleText(c)),
    ),
    sticky_header: stickyHeader,
  };
  if (kind === "home") {
    facts.hero_height = hero
      ? Math.round(hero.getBoundingClientRect().height)
      : null;
    facts.hero_is_carousel = hero
      ? !!hero.closest(
          "[class*='swiper' i], [class*='carousel' i], [class*='slider' i], [class*='slick' i], [class*='splide' i], [class*='embla' i]",
        )
      : null;
    facts.shelves = shelves;
  } else {
    facts.sticky_filter = stickyFilter;
    facts.results_total = totalMatch
      ? Number(totalMatch[1]!.replace(/[.,]/g, ""))
      : null;
    facts.pagination = loadMore
      ? /(próxima|proxima|next)/i.test(visibleText(loadMore))
        ? "paginação"
        : "botão de carregar mais"
      : "sem botão (rolagem infinita ou lista inteira)";
  }
  if (kind === "busca") facts.no_results = noResults;
  return {
    page_height: pageHeight,
    positions,
    selectors,
    above_fold_outline: outline,
    facts,
  };
}

// ── Design system ────────────────────────────────────────────────────────────

/** Espelho de DesignSystem (types.ts) sem os campos que o servidor preenche. */
export interface ExtractedDesignSystem {
  css_variables: Record<string, string>;
  palette: Array<{ color: string; uses: number }>;
  fonts: string[];
  typography: Record<
    "body" | "heading" | "price" | "link",
    Record<string, string> | null
  >;
  components: Record<
    "primary_button" | "secondary_button" | "size_chip" | "badge" | "input",
    Record<string, string> | null
  >;
  radii: string[];
  spacing: string[];
  buy_box: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Lê o design system da página aberta: variáveis CSS, paleta por uso, fontes,
 * tipografia de corpo/título/preço/link e o estilo dos componentes que um
 * mockup de PDP mais reusa (botão, chip de tamanho, selo, campo).
 */
export function extractDesignSystemInPage(): ExtractedDesignSystem {
  // Rolagem de quem rola a página (a janela ou o <body>, numa loja; 14/11).
  // Mesmo corpo de `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  // Texto visível, sem o conteúdo de SCRIPT/STYLE/NOSCRIPT/TEMPLATE: sites
  // TanStack embutem o JSON do evento de analytics DENTRO do botão, e o
  // textContent de "Adicionar à sacola" passava de 40 caracteres (14/11).
  // Mesmo corpo de `visibleTextOf` (testado fora do navegador).
  const visibleText = (node: Node): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  const hex = (color: string): string | null => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a] = m[1]!.split(",").map((x) => Number.parseFloat(x));
    if (a !== undefined && a < 0.1) return null;
    const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
    return `#${h(r!)}${h(g!)}${h(b!)}`;
  };
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 3; depth++) {
      const classes = Array.from(node.classList)
        .filter((c) => /^[A-Za-z][\w-]*$/.test(c))
        .slice(0, 2);
      parts.unshift(
        node.tagName.toLowerCase() + classes.map((c) => `.${c}`).join(""),
      );
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  // `rounded-full` do Tailwind vira 9999px, e calc() devolve 3.35544e+07px.
  // Pro prompt e pra tela isso é "pílula", não um número.
  const radius = (r: string): string =>
    /e\+|^\d{4,}/.test(r) || Number.parseFloat(r) >= 999 ? "9999px" : r;
  const textStyle = (el: Element | null): Record<string, string> | null => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      font_family: s.fontFamily,
      font_size: s.fontSize,
      font_weight: s.fontWeight,
      line_height: s.lineHeight,
      letter_spacing: s.letterSpacing,
      text_transform: s.textTransform,
      color: hex(s.color) ?? s.color,
    };
  };
  const boxStyle = (el: Element | null): Record<string, string> | null => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      ...(textStyle(el) as Record<string, string>),
      background: hex(s.backgroundColor) ?? "transparent",
      border:
        Number.parseFloat(s.borderTopWidth) > 0
          ? `${s.borderTopWidth} ${s.borderTopStyle} ${hex(s.borderTopColor) ?? s.borderTopColor}`
          : "none",
      border_radius: radius(s.borderRadius),
      padding: s.padding,
      height: `${Math.round(el.getBoundingClientRect().height)}px`,
      selector: cssPath(el),
      sample_text: visibleText(el).slice(0, 40),
    };
  };

  const all = Array.from(document.querySelectorAll("body *"))
    .filter(visible)
    .slice(0, 4000);

  // Variáveis CSS: o Chrome enumera custom properties no computed style.
  const vars: Record<string, string> = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootStyle.length && Object.keys(vars).length < 80; i++) {
    const name = rootStyle[i]!;
    if (!name.startsWith("--")) continue;
    const value = rootStyle.getPropertyValue(name).trim();
    if (value && value.length < 80) vars[name] = value;
  }

  // Paleta e fontes por frequência.
  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  const radii = new Map<string, number>();
  const spacing = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string | null, n = 1) => {
    if (k) m.set(k, (m.get(k) ?? 0) + n);
  };
  for (const el of all) {
    const s = getComputedStyle(el);
    const hasText = el.children.length === 0 && visibleText(el).length > 0;
    if (hasText) bump(colors, hex(s.color));
    bump(colors, hex(s.backgroundColor), 2);
    if (Number.parseFloat(s.borderTopWidth) > 0)
      bump(colors, hex(s.borderTopColor));
    if (hasText)
      bump(fonts, s.fontFamily.split(",")[0]!.replace(/["']/g, "").trim());
    const tag = el.tagName.toLowerCase();
    if (
      tag === "button" ||
      tag === "input" ||
      el.getAttribute("role") === "button"
    ) {
      if (s.borderRadius !== "0px") bump(radii, radius(s.borderRadius));
      bump(spacing, s.padding);
    }
    if (s.gap && s.gap !== "normal") bump(spacing, s.gap);
  }
  const top = (m: Map<string, number>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  // Componentes.
  const buyWords = /(adicionar|comprar|sacola|carrinho|add to (bag|cart)|buy)/i;
  const buttons = all.filter((el) => {
    const tag = el.tagName.toLowerCase();
    return (
      tag === "button" ||
      el.getAttribute("role") === "button" ||
      (tag === "a" && el.getAttribute("href") === null)
    );
  });
  const primary =
    buttons
      .filter((b) => buyWords.test(visibleText(b)))
      .sort(
        (a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height,
      )[0] ?? null;
  const secondary =
    buttons.find((b) => {
      if (
        b === primary ||
        visibleText(b).length < 3 ||
        visibleText(b).length > 30
      )
        return false;
      const s = getComputedStyle(b);
      return !hex(s.backgroundColor) && Number.parseFloat(s.borderTopWidth) > 0;
    }) ?? null;
  const sizeToken = /^(PP|P|M|G|GG|XG|XS|S|L|XL|U|\d{2})$/i;
  const chip =
    all.find(
      (el) => el.children.length === 0 && sizeToken.test(visibleText(el)),
    ) ?? null;
  const chipBox =
    chip &&
    getComputedStyle(chip).borderTopWidth === "0px" &&
    chip.parentElement
      ? chip.parentElement
      : chip;
  const badge =
    all.find((el) => {
      if (el.children.length > 0) return false;
      const t = visibleText(el);
      if (t.length < 2 || t.length > 14) return false;
      const s = getComputedStyle(el);
      return (
        Boolean(hex(s.backgroundColor)) && Number.parseFloat(s.fontSize) <= 13
      );
    }) ?? null;
  const input =
    all.find(
      (el) =>
        el.tagName.toLowerCase() === "input" &&
        /^(text|email|tel|search|)$/.test(el.getAttribute("type") ?? ""),
    ) ?? null;

  // Tipografia.
  const h1 = all.find((el) => el.tagName.toLowerCase() === "h1") ?? null;
  const money = /(R\$|US\$|\$|€|£)\s?\d/;
  const price =
    all
      .filter(
        (el) =>
          el.children.length <= 2 &&
          money.test(visibleText(el)) &&
          visibleText(el).length < 30,
      )
      .sort(
        (a, b) =>
          Number.parseFloat(getComputedStyle(b).fontSize) -
          Number.parseFloat(getComputedStyle(a).fontSize),
      )[0] ?? null;
  const paragraph =
    all.find(
      (el) => el.tagName.toLowerCase() === "p" && visibleText(el).length > 60,
    ) ?? document.body;
  const link =
    all.find(
      (el) =>
        el.tagName.toLowerCase() === "a" &&
        visibleText(el).length > 3 &&
        visibleText(el).length < 40,
    ) ?? null;

  // Bloco de compra: união de preço e botão (e do que estiver entre eles).
  let buyBox: ExtractedDesignSystem["buy_box"] = null;
  if (price && primary) {
    const a = price.getBoundingClientRect();
    const b = primary.getBoundingClientRect();
    const scroller = pageScroller();
    const pageY =
      window.scrollY + (scroller?.contains(price) ? scroller.scrollTop : 0);
    const y1 = Math.min(a.top, b.top) + pageY - 16;
    const y2 = Math.max(a.bottom, b.bottom) + pageY + 16;
    if (y2 - y1 > 0 && y2 - y1 < 1600) {
      buyBox = {
        x: 0,
        y: Math.max(0, Math.round(y1)),
        width: window.innerWidth,
        height: Math.round(y2 - y1),
      };
    }
  }

  return {
    css_variables: vars,
    palette: top(colors, 14).map(([color, uses]) => ({ color, uses })),
    fonts: top(fonts, 5).map(([f]) => f),
    typography: {
      body: textStyle(paragraph),
      heading: textStyle(h1),
      price: textStyle(price),
      link: textStyle(link),
    },
    components: {
      primary_button: boxStyle(primary),
      secondary_button: boxStyle(secondary),
      size_chip: boxStyle(chipBox),
      badge: boxStyle(badge),
      input: boxStyle(input),
    },
    radii: top(radii, 6).map(([r]) => r),
    spacing: top(spacing, 8).map(([s]) => s),
    buy_box: buyBox,
  };
}

// ── Trecho do DOM pro mockup ─────────────────────────────────────────────────

/**
 * HTML resumido do miolo da PDP (do preço até a recomendação), pro modelo
 * escrever um patch com as classes reais da loja. Sem script, sem svg, atributos
 * só class/id/role/aria, texto encurtado — cabe no prompt.
 */
export function domExcerptInPage(selector: string | null): string {
  const anchor =
    (selector ? document.querySelector(selector) : null) ??
    document.querySelector("main") ??
    document.body;
  // Sobe até um ancestral grande o bastante pra conter o bloco de compra.
  let root: Element = anchor;
  for (let i = 0; i < 4 && root.parentElement; i++) {
    if (root.getBoundingClientRect().height > window.innerHeight * 0.8) break;
    root = root.parentElement;
  }
  const keep = new Set([
    "class",
    "id",
    "role",
    "aria-label",
    "type",
    "href",
    "placeholder",
  ]);
  const out: string[] = [];
  const walk = (el: Element, depth: number) => {
    if (out.join("").length > 9000 || depth > 9) return;
    const tag = el.tagName.toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "svg" ||
      tag === "noscript"
    )
      return;
    const attrs = Array.from(el.attributes)
      .filter((a) => keep.has(a.name))
      .map((a) => `${a.name}="${a.value.slice(0, 80)}"`)
      .join(" ");
    const pad = "  ".repeat(depth);
    const kids = Array.from(el.children);
    if (kids.length === 0) {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      out.push(`${pad}<${tag}${attrs ? ` ${attrs}` : ""}>${t}</${tag}>\n`);
      return;
    }
    out.push(`${pad}<${tag}${attrs ? ` ${attrs}` : ""}>\n`);
    for (const k of kids.slice(0, 25)) walk(k, depth + 1);
    out.push(`${pad}</${tag}>\n`);
  };
  walk(root, 0);
  return out.join("").slice(0, 10_000);
}

// ── Injetar o patch ──────────────────────────────────────────────────────────

export interface MockupPatch {
  /** CSS adicionado à página (pode sobrescrever classes da loja). */
  css: string;
  /** Inserções de HTML relativas a um elemento existente. */
  inserts: Array<{
    selector: string;
    position:
      | "beforebegin"
      | "afterbegin"
      | "beforeend"
      | "afterend"
      | "replace";
    html: string;
  }>;
  /** Elementos a esconder (ex.: o bloco antigo que o novo substitui). */
  hide: string[];
  /** Rolar até aqui antes do print "Depois" (px do topo). */
  scroll_to: number | null;
}

/**
 * Aplica o patch na página real. Devolve quantas mudanças pegaram — o servidor
 * recusa o "Depois" se nada pegou, porque aí o print seria igual ao "Antes" e
 * mentiria que a mudança está ali.
 *
 * CSS só conta quando a regra casa com algum elemento, medido DEPOIS das
 * inserções (a regra pode estilizar o que o patch acabou de inserir). Contar
 * "CSS não vazio" deixou passar, em 05/11, um patch só com classes que não
 * existiam na página: o Depois saiu idêntico ao Antes.
 */
export function applyPatchInPage(patch: MockupPatch): {
  applied: number;
  missing: string[];
  /** Seletores do CSS que não casaram com nada (até 10). */
  css_unmatched: string[];
} {
  const style = document.createElement("style");
  style.setAttribute("data-ux-mockup", "1");
  style.textContent = patch.css ?? "";
  document.head.appendChild(style);
  let applied = 0;
  const missing: string[] = [];
  for (const ins of patch.inserts ?? []) {
    let target: Element | null = null;
    try {
      target = document.querySelector(ins.selector);
    } catch {
      target = null;
    }
    if (!target) {
      missing.push(ins.selector);
      continue;
    }
    if (ins.position === "replace") {
      target.outerHTML = ins.html;
    } else {
      target.insertAdjacentHTML(ins.position, ins.html);
    }
    applied += 1;
  }
  for (const selector of patch.hide ?? []) {
    try {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        (el as HTMLElement).style.setProperty("display", "none", "important");
      }
    } catch {
      missing.push(selector);
    }
  }
  // Estado (:hover, :disabled…) e pseudo-elemento (::placeholder) não casam
  // no querySelector; o que interessa é se o elemento-base existe.
  const statePseudo =
    /::?(hover|focus|focus-visible|focus-within|active|visited|disabled|checked|target|placeholder|before|after|first-letter|first-line|selection|marker|-webkit-[\w-]+)(\([^)]*\))?/g;
  const cssUnmatched: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const base = rule.selectorText.replace(statePseudo, "").trim();
        let hit = false;
        try {
          hit = !!base && document.querySelector(base) !== null;
        } catch {
          hit = false;
        }
        if (hit) applied += 1;
        else if (cssUnmatched.length < 10) cssUnmatched.push(rule.selectorText);
      } else if ("cssRules" in rule) {
        // @media / @supports: conta as regras de dentro.
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  if (style.sheet) visit(style.sheet.cssRules);
  return { applied, missing, css_unmatched: cssUnmatched };
}

// ── Mapa de blocos pro mockup ────────────────────────────────────────────────

/**
 * Os blocos grandes das duas primeiras telas, com seletor e geometria (px do
 * topo, altura, largura), em texto pro prompt do mockup.
 *
 * O trecho do DOM do mockup começa no bloco de compra; a galeria de fotos, que
 * é o que ocupa a primeira tela de uma PDP no celular, ficava fora dele. Sem
 * saber o seletor e a altura da foto, o modelo prometia "foto menor, compra na
 * primeira tela" e entregava um bloco novo ABAIXO da foto (H3 de 05/11).
 */
export interface LayoutBlock {
  /** Seletor — posição — tamanho, em texto pro prompt. */
  line: string;
  /** O `class` inteiro do elemento: é por ele que o código da loja é achado. */
  class_name: string;
}

export function layoutOutlineInPage(): LayoutBlock[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const box = (el: Element) => el.getBoundingClientRect();
  // Rolagem de quem rola a página (a janela ou o <body>, numa loja; 14/11).
  // Mesmo corpo de `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const scroller = pageScroller();
  const docTop = (el: Element) =>
    Math.round(
      box(el).top +
        window.scrollY +
        (scroller?.contains(el) ? scroller.scrollTop : 0),
    );
  const shown = (el: Element): boolean => {
    const r = box(el);
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const same = (a: DOMRect, b: DOMRect) =>
    Math.abs(a.height - b.height) < 4 && Math.abs(a.width - b.width) < 4;
  // Seletor curto que aponta só pra este elemento: id quando dá, senão
  // tag.classes com :nth-of-type onde há irmão do mesmo tipo.
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && node !== document.body && depth < 6; depth++) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const cur: Element = node;
      let part =
        cur.tagName.toLowerCase() +
        Array.from(cur.classList)
          .filter((c) => /^[A-Za-z][\w-]*$/.test(c))
          .slice(0, 2)
          .map((c) => `.${c}`)
          .join("");
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const twins = Array.from(parent.children).filter(
          (c) => c.tagName === cur.tagName,
        );
        if (twins.length > 1) part += `:nth-of-type(${twins.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(" > ");
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        /* seletor inválido: continua subindo */
      }
      node = parent;
    }
    return parts.join(" > ");
  };

  const lines: Array<{ top: number; text: string; class_name: string }> = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (lines.length >= 40) break;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg") continue;
    if (!shown(el)) continue;
    const r = box(el);
    const top = docTop(el);
    if (top > vh * 2) continue;
    const media = tag === "img" || tag === "picture" || tag === "video";
    const big = r.width >= vw * 0.5 && r.height >= 40;
    if (!big && !(media && r.width * r.height >= vw * vh * 0.15)) continue;
    // Wrapper do mesmo tamanho do pai não acrescenta nada: fica o de fora.
    const parent = el.parentElement;
    if (parent && parent !== document.body && same(box(parent), r)) continue;
    const fixed = getComputedStyle(el).position;
    // innerText, não textContent: este traz o CSS de <style> inline junto.
    const text = ((el as HTMLElement).innerText ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);
    lines.push({
      top,
      class_name: typeof el.className === "string" ? el.className.trim() : "",
      text: `${selectorOf(el)} — topo ${top}px, altura ${Math.round(r.height)}px, largura ${Math.round(r.width)}px${fixed === "fixed" || fixed === "sticky" ? ` (${fixed})` : ""}${media ? " [mídia]" : ""}${text ? ` "${text}"` : ""}`,
    });
  }
  return lines
    .sort((a, b) => a.top - b.top)
    .map((l) => ({ line: l.text, class_name: l.class_name }));
}

// ── Achar PDP, vitrine e busca numa loja qualquer (benchmark) ────────────────

/**
 * Os links da página como a cliente os vê: href absoluto, em que parte da
 * página estão (menu, cabeçalho, conteúdo, rodapé), o texto e se têm foto. Quem
 * decide o que é PDP ou vitrine é `classifyStoreLinks` (store-discovery.ts),
 * fora da página. `text` é o começo do texto visível do conteúdo, pra dizer se
 * uma busca respondeu "nenhum resultado"; `heading` (título, h1, caixa de
 * busca) diz se ela respondeu pelo termo: o menu pode citar o termo em qualquer
 * página.
 */
export function storeLinksInPage(): {
  origin: string;
  links: Array<{
    href: string;
    zone: "nav" | "header" | "main" | "footer" | "other";
    text: string;
    image: boolean;
  }>;
  text: string;
  heading: string;
} {
  const links: Array<{
    href: string;
    zone: "nav" | "header" | "main" | "footer" | "other";
    text: string;
    image: boolean;
  }> = [];
  for (const a of Array.from(
    document.querySelectorAll("a[href]"),
  ) as HTMLAnchorElement[]) {
    if (links.length >= 600) break;
    const zone = a.closest("footer, [role=contentinfo]")
      ? "footer"
      : a.closest("nav, [role=navigation], [role=menubar]")
        ? "nav"
        : a.closest("header, [role=banner]")
          ? "header"
          : a.closest("main, [role=main]")
            ? "main"
            : "other";
    links.push({
      href: a.href,
      zone,
      text: (a.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      image:
        a.querySelector("img, picture, [style*=background-image]") !== null,
    });
  }
  const main = document.querySelector("main, [role=main]") ?? document.body;
  const heading = [
    document.title,
    ...(Array.from(document.querySelectorAll("h1")) as HTMLElement[])
      .slice(0, 3)
      .map((h) => h.innerText),
    ...(
      Array.from(
        document.querySelectorAll("input[type=search], input[name]"),
      ) as HTMLInputElement[]
    )
      .filter(
        (i) =>
          i.type === "search" ||
          /^(q|_q|ft|query|search|busca|s)$/i.test(i.name),
      )
      .slice(0, 3)
      .map((i) => i.value),
  ];
  return {
    origin: location.origin,
    links,
    text: ((main as HTMLElement | null)?.innerText ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 4000),
    heading: heading.join(" | ").replace(/\s+/g, " ").slice(0, 500),
  };
}

/**
 * O que acha a busca da loja: os formulários (action como está no HTML, inputs
 * com nome) e o começo do HTML, onde a plataforma deixa rastro. A escolha da
 * rota é `searchRoutes` (store-discovery.ts).
 */
export function searchHintsInPage(): {
  pageUrl: string;
  forms: Array<{
    action: string;
    method: string;
    inputs: Array<{ name: string; type: string; value: string }>;
  }>;
  html: string;
} {
  const forms = (Array.from(document.forms) as HTMLFormElement[])
    .slice(0, 20)
    .map((form) => ({
      action: form.getAttribute("action") ?? "",
      method: form.getAttribute("method") ?? "get",
      inputs: (
        Array.from(form.querySelectorAll("input[name]")) as HTMLInputElement[]
      )
        .slice(0, 12)
        .map((input) => ({
          name: input.name,
          type: (input.getAttribute("type") ?? "text").toLowerCase(),
          value: input.type === "hidden" ? input.value : "",
        })),
    }));
  return {
    pageUrl: location.href,
    forms,
    html: document.documentElement.outerHTML.slice(0, 60_000),
  };
}

/**
 * A página aberta é uma PDP? JSON-LD `Product`/`ProductGroup` (o Shopify usa o
 * segundo; `@type` pode vir em array ou dentro de `@graph`), microdata
 * schema.org/Product ou og:type product.
 */
export function isProductPageInPage(): boolean {
  for (const s of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  )) {
    const raw = s.textContent ?? "";
    if (/"@type"\s*:\s*\[?[^\]}]*?"Product(Group)?"/.test(raw)) return true;
  }
  if (document.querySelector('[itemtype*="schema.org/Product" i]')) return true;
  const og = document.querySelector('meta[property="og:type"]');
  return /product/i.test(og?.getAttribute("content") ?? "");
}

/**
 * O pedaço da página que `classifyBotWall` (browser.ts) precisa pra dizer se é
 * um muro anti-robô: quantos links, o começo do HTML e do texto. A decisão fica
 * fora da página pra ser testável.
 */
export function wallSnapshotInPage(): {
  links: number;
  html: string;
  text: string;
} {
  return {
    links: document.querySelectorAll("a[href]").length,
    html: document.documentElement.outerHTML.slice(0, 20_000),
    text: (document.body?.innerText ?? "").slice(0, 2_000),
  };
}

// ── Dar nome aos elementos do heatmap ────────────────────────────────────────

/**
 * Para cada `root|el` pedido (do `hmElements` do Deco Analytics), o que aquele
 * elemento é nesta página: tag, texto e posição. O coletor só manda o hash do
 * caminho até o elemento; aqui se calcula o MESMO hash no DOM vivo e se casa.
 *
 * O algoritmo é cópia do `shared/anchor.ts` do repo decocms/analytics
 * (ANCHOR_VERSION 1), que é a única definição de "qual elemento foi clicado":
 * root = `section[data-manifest-key]` (chave + "#" + ordinal), senão o
 * `data-fs-*` mais externo, senão um id estável, senão body; caminho =
 * `tag[data-fs-x]:n-of-type` do root até o elemento; hash = cyrb53, que o
 * Studio devolve em decimal. Se o analytics subir a versão, isto para de casar
 * (o elemento fica sem rótulo, não com rótulo errado).
 *
 * Cada elemento da página é hasheado, não só os clicáveis: um clique numa
 * imagem ancora na própria imagem. Os que nunca são âncora não casam com nada.
 *
 * O elemento casado ganha `data-ux-anchor="<root>|<el>"`: é por ele que o
 * verificador acha o alvo depois (`[data-ux-anchor="..."]`), sem recalcular o
 * hash a cada passo. As marcas antigas saem antes, porque depois de um clique
 * o DOM pode ter mudado e a mesma chave casar com outro elemento.
 */
export function elementLabelsInPage(
  wanted: string[],
): Record<
  string,
  { label: string; y: number; navigates?: string; hidden?: boolean }
> {
  const want = new Set(wanted);
  const out: Record<
    string,
    { label: string; y: number; navigates?: string; hidden?: boolean }
  > = {};
  if (want.size === 0) return out;
  // Rolagem de quem rola a página (a janela ou o <body>, numa loja; 14/11).
  // Mesmo corpo de `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const scroller = pageScroller();
  const WRAPPER =
    /^(home|page|layout|content|main|root|wrapper|container|region|grid)$/;
  const BAD_ID = /\d{4,}|^:r|^radix-|^headlessui-|[0-9a-f]{8}|react-aria|[:«»]/;
  const cyrb53 = (str: string, seed = 0): number => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  };
  const fsAttr = (e: Element): string => {
    let m = "";
    for (const n of e.getAttributeNames()) {
      if (n.startsWith("data-fs-") && (!m || n < m)) m = n;
    }
    return m;
  };
  const fsRootName = (e: Element): string => {
    const a = fsAttr(e);
    return a && !WRAPPER.test(a.slice(8)) && /^[a-z0-9-]+$/.test(a) ? a : "";
  };
  const ordinal = (
    list: NodeListOf<Element>,
    e: Element,
    same: (x: Element) => boolean,
  ): number => {
    let n = 0;
    for (const x of Array.from(list)) {
      if (x === e) return n;
      if (same(x)) n++;
    }
    return n;
  };
  const rootOf = (a: Element): [Element | null, string] => {
    const s = a.closest("section[data-manifest-key]");
    if (s) {
      const k = s.getAttribute("data-manifest-key") ?? "";
      return [
        s,
        `${k}#${ordinal(
          document.querySelectorAll("section[data-manifest-key]"),
          s,
          (x) => x.getAttribute("data-manifest-key") === k,
        )}`,
      ];
    }
    let fs: Element | null = null;
    let name = "";
    for (
      let e: Element | null = a;
      e && e !== document.body;
      e = e.parentElement
    ) {
      const n = fsRootName(e);
      if (n) {
        fs = e;
        name = n;
      }
    }
    if (fs) {
      return [
        fs,
        `fs:${name.slice(8)}#${ordinal(
          document.querySelectorAll(`[${name}]`),
          fs,
          () => true,
        )}`,
      ];
    }
    for (
      let e: Element | null = a;
      e && e !== document.body;
      e = e.parentElement
    ) {
      if (e.id && !BAD_ID.test(e.id)) return [e, `#${e.id}`];
    }
    return [null, ""];
  };
  const pathOf = (root: Element | null, a: Element): string => {
    const parts: string[] = [];
    for (
      let e: Element | null = a, i = 0;
      e && e !== root && e !== document.body && i < 64;
      e = e.parentElement, i++
    ) {
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.localName === e.localName) n++;
      }
      const f = fsAttr(e);
      parts.push(`${e.localName}${f ? `[${f}]` : ""}:${n}`);
    }
    return parts.reverse().join(">");
  };
  // Texto visível, sem o conteúdo de SCRIPT/STYLE/NOSCRIPT/TEMPLATE: sites
  // TanStack embutem o JSON do evento de analytics DENTRO do botão, e o
  // textContent de "Adicionar à sacola" passava de 40 caracteres (14/11).
  // Mesmo corpo de `visibleTextOf` (testado fora do navegador).
  const visibleText = (node: Node): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // Rótulo pra exibir: sem sub-árvore escondida (tooltip). Mesmo corpo de
  // `labelTextOf` (revisão, 14/11).
  const hiddenNode = (n: TextTreeNode): boolean => {
    const st = getComputedStyle(n as unknown as Element);
    return st.display === "none" || st.visibility === "hidden";
  };
  const labelText = (
    node: TextTreeNode,
    hidden: (n: TextTreeNode) => boolean,
  ): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      if (hidden(n)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // Mesmo corpo de `navigationOf` (testado fora do navegador).
  const navigationOf = (e: ActionNode, here: string): string => {
    let to = "";
    const link = e.closest("a[href]");
    if (link) {
      const href = (link.getAttribute("href") ?? "").trim();
      if (
        href &&
        !href.startsWith("#") &&
        !/^(javascript|mailto|tel):/i.test(href)
      ) {
        to = href;
      }
    } else {
      const button = e.closest(
        "button, input[type='submit'], input[type='image']",
      );
      const form = button ? button.closest("form") : null;
      if (button && form) {
        const type = (
          button.getAttribute("type") ??
          (button.localName === "button" ? "submit" : "")
        ).toLowerCase();
        if (type === "submit" || type === "image") {
          to = (form.getAttribute("action") ?? "").trim() || here;
        }
      }
    }
    if (!to) return "";
    try {
      const url = new URL(to, here);
      const base = new URL(here);
      return url.host === base.host
        ? url.pathname
        : `${url.host}${url.pathname}`;
    } catch {
      return "";
    }
  };
  const describe = (e: Element): string => {
    const attr = (n: string) => (e.getAttribute(n) ?? "").trim();
    // innerText de elemento escondido (ou SVG) cai no textContent, com o
    // JSON de <script> junto: o texto visível não depende de renderizar.
    // Elemento todo escondido não tem rótulo: aí vale o texto inteiro.
    let text =
      attr("aria-label") ||
      attr("title") ||
      attr("alt") ||
      labelText(e, hiddenNode) ||
      visibleText(e);
    if (!text && e.localName === "input") {
      text = attr("placeholder") || attr("value") || attr("name");
    }
    if (!text) {
      const img = e.querySelector("img[alt]");
      text = img ? `imagem: ${img.getAttribute("alt") ?? ""}`.trim() : "";
    }
    if (text.length > 60) text = `${text.slice(0, 57)}...`;
    const role = attr("role");
    return `${e.localName}${role ? `[${role}]` : ""}${text ? ` "${text}"` : ""}`;
  };
  for (const marked of Array.from(
    document.querySelectorAll("[data-ux-anchor]"),
  )) {
    marked.removeAttribute("data-ux-anchor");
  }
  const all = document.body ? document.body.querySelectorAll("*") : [];
  let seen = 0;
  for (const e of Array.from(all)) {
    if (++seen > 30_000) break;
    const [rootEl, root] = rootOf(e);
    const key = `${root}|${cyrb53(`${root}|${pathOf(rootEl, e)}`)}`;
    if (!want.has(key) || out[key]) continue;
    e.setAttribute("data-ux-anchor", key);
    const rect = e.getBoundingClientRect();
    const entry: (typeof out)[string] = {
      label: describe(e),
      y: Math.round(
        rect.top +
          window.scrollY +
          (scroller?.contains(e) ? scroller.scrollTop : 0),
      ),
    };
    const to = navigationOf(e, location.href);
    if (to) entry.navigates = to;
    // Escondido na carga: está num painel que outro clique abre (a busca
    // de uma loja). O y dele não é posição na página.
    const hasBox = rect.width > 0 || rect.height > 0;
    const shown =
      hasBox &&
      (typeof e.checkVisibility !== "function" ||
        e.checkVisibility({ visibilityProperty: true }));
    if (!shown) entry.hidden = true;
    out[key] = entry;
    if (Object.keys(out).length === want.size) break;
  }
  return out;
}

// ── Verificador de hipóteses ─────────────────────────────────────────────────

/**
 * O que um alvo do verificador é e como ele se parece: tag, texto do clicável
 * que o contém, cores, cursor, sublinhado, se está em link/botão/formulário.
 * Serve pro passo `inspect` e pra `forbiddenReason` (verify/safety.ts) decidir
 * se dá pra clicar. Seletor inválido ou que não casa volta `found: false`.
 */
export function elementFactsInPage(selector: string): ElementFacts {
  // Rótulo pra exibir: sem sub-árvore escondida (tooltip). Mesmo corpo de
  // `labelTextOf` (revisão, 14/11).
  const hiddenNode = (n: TextTreeNode): boolean => {
    const st = getComputedStyle(n as unknown as Element);
    return st.display === "none" || st.visibility === "hidden";
  };
  const labelText = (
    node: TextTreeNode,
    hidden: (n: TextTreeNode) => boolean,
  ): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      if (hidden(n)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  // Rolagem de quem rola a página (a janela ou o <body>, numa loja; 14/11).
  // Mesmo corpo de `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visível e cobrindo a tela: gaveta fora da tela não é a página (revisão, 14/11).
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const body = document.body;
    if (!body) return null;
    if (scrolls(body)) return body;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!scrolls(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
  const empty: ElementFacts = {
    found: false,
    tag: "",
    text: "",
    role: null,
    type: null,
    inLink: false,
    inButton: false,
    href: null,
    linkTarget: null,
    cursor: "",
    color: "",
    parentColor: "",
    textDecoration: "",
    hasClickHandler: false,
    inForm: false,
    inputType: null,
    rect: null,
  };
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return empty;
  }
  if (!el) return empty;
  // Texto visível, sem o conteúdo de SCRIPT/STYLE/NOSCRIPT/TEMPLATE: sites
  // TanStack embutem o JSON do evento de analytics DENTRO do botão, e o
  // textContent de "Adicionar à sacola" passava de 40 caracteres (14/11).
  // Mesmo corpo de `visibleTextOf` (testado fora do navegador).
  const visibleText = (node: Node): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  const attr = (e: Element, n: string): string =>
    (e.getAttribute(n) ?? "").trim();
  const hex = (color: string): string => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return color;
    const [r, g, b, a] = m[1]!.split(",").map((x) => Number.parseFloat(x));
    if (a !== undefined && a < 0.1) return "transparente";
    const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
    return `#${h(r!)}${h(g!)}${h(b!)}`;
  };
  const tag = el.localName;
  const s = getComputedStyle(el);
  const link = el.closest("a[href]") as HTMLAnchorElement | null;
  const button = el.closest("button, [role='button']");
  // O texto que decide se é proibido é o do clicável que contém o alvo: um
  // ícone dentro de "Adicionar à sacola" clica no botão do mesmo jeito.
  const clickable =
    el.closest("button, a[href], [role='button'], label, summary") ?? el;
  // Texto visível E rótulos, sempre juntos: botão só de ícone tem o <title>
  // do SVG ("icon-bag") como texto e o "Adicionar à sacola" no aria-label, e
  // ler o rótulo só com texto vazio liberava o clique (revisão, 14/11).
  let text = [
    visibleText(clickable),
    attr(clickable, "aria-label"),
    attr(clickable, "title"),
    attr(clickable, "value"),
  ]
    .filter((t, i, all) => t && all.indexOf(t) === i)
    .join(" ");
  if (tag === "input" || tag === "textarea" || tag === "select") {
    text = ["placeholder", "aria-label", "name", "id", "autocomplete"]
      .map((n) => attr(el as Element, n))
      .filter(Boolean)
      .join(" ");
  }
  const btn = (
    tag === "button" ? el : el.closest("button")
  ) as HTMLButtonElement | null;
  // <button> sem type dentro de <form> É submit (padrão do HTML): clicar envia
  // o formulário. Fora de form o atributo cru basta.
  const type = btn
    ? btn.form
      ? btn.type
      : btn.getAttribute("type")
    : el.getAttribute("type");
  // Sublinhado de um <a> pai não aparece no computed style do filho.
  let decoration = "none";
  for (
    let n: Element | null = el, i = 0;
    n && i < 4;
    n = n.parentElement, i++
  ) {
    const d = getComputedStyle(n).textDecorationLine;
    if (d && d !== "none") {
      decoration = d;
      break;
    }
  }
  // Invólucro de tamanho zero (o #NewsletterPopup de uma loja mede 390×0
  // aberto, e quem aparece é o filho fixed): medida, cor e cursor vêm do maior
  // filho visível. Texto, link e a trava de clique seguem sendo do alvo (14/11).
  const own = el.getBoundingClientRect();
  const scroller = pageScroller();
  const pageY =
    window.scrollY + (scroller?.contains(el) ? scroller.scrollTop : 0);
  let shown: Element = el;
  let wrapper: ElementFacts["wrapper"] = null;
  if (own.width < 2 || own.height < 2) {
    // Só filho que aparece MESMO (revisão, 14/11): acordeão fechado é um
    // invólucro height:0 overflow:hidden com filhos de tamanho, e eles não
    // aparecem. Um corte (overflow hidden/clip) entre o filho e o alvo vale,
    // a não ser que um fixed no caminho escape dele; e o filho tem que cair
    // dentro do documento (ou da tela, se fixed).
    const clips = (st: CSSStyleDeclaration) =>
      /(hidden|clip)/.test(`${st.overflow} ${st.overflowX} ${st.overflowY}`);
    const docW = document.documentElement.scrollWidth;
    const docH = Math.max(
      document.documentElement.scrollHeight,
      scroller ? scroller.scrollHeight : 0,
    );
    let best = 0;
    const kids = el.querySelectorAll("*");
    for (let i = 0; i < kids.length && i < 3000; i++) {
      const k = kids[i]!;
      const kr = k.getBoundingClientRect();
      if (kr.width < 2 || kr.height < 2) continue;
      const ks = getComputedStyle(k);
      const check = (
        k as {
          checkVisibility?: (o: {
            opacityProperty: boolean;
            visibilityProperty: boolean;
          }) => boolean;
        }
      ).checkVisibility;
      if (typeof check === "function") {
        if (!check.call(k, { opacityProperty: true, visibilityProperty: true }))
          continue;
      } else if (
        ks.display === "none" ||
        ks.visibility === "hidden" ||
        Number.parseFloat(ks.opacity) === 0
      )
        continue;
      // Corte no caminho até o alvo (inclusive), abaixo do primeiro fixed.
      let fixed = ks.position === "fixed";
      let clipped = false;
      for (
        let n: Element | null = k.parentElement;
        n && !fixed;
        n = n.parentElement
      ) {
        const ns = getComputedStyle(n);
        if (clips(ns)) {
          const nr = n.getBoundingClientRect();
          const w = Math.min(kr.right, nr.right) - Math.max(kr.left, nr.left);
          const h = Math.min(kr.bottom, nr.bottom) - Math.max(kr.top, nr.top);
          if (w < 2 || h < 2) {
            clipped = true;
            break;
          }
        }
        if (ns.position === "fixed") fixed = true;
        if (n === el) break;
      }
      if (clipped) continue;
      // Dentro da tela (fixed) ou do documento (o resto).
      const inside = fixed
        ? kr.right > 0 &&
          kr.bottom > 0 &&
          kr.left < window.innerWidth &&
          kr.top < window.innerHeight
        : kr.right + window.scrollX > 0 &&
          kr.bottom + pageY > 0 &&
          kr.left + window.scrollX < docW &&
          kr.top + pageY < docH;
      if (!inside) continue;
      if (kr.width * kr.height > best) {
        best = kr.width * kr.height;
        shown = k;
      }
    }
    if (shown !== el) {
      const classes = String(shown.getAttribute("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const id = shown.id ? `#${shown.id}` : "";
      const cls = classes
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      wrapper = {
        width: Math.round(own.width),
        height: Math.round(own.height),
        child: `${shown.localName}${id}${cls}${classes.length > 2 ? "…" : ""}`,
      };
    }
  }
  const r = shown === el ? own : shown.getBoundingClientRect();
  const shownStyle = shown === el ? s : getComputedStyle(shown);
  return {
    found: true,
    tag,
    // Inteiro: "Adicionar à sacola" depois do 200º caractere ainda proíbe.
    text,
    label: labelText(el, hiddenNode),
    role: el.getAttribute("role"),
    type,
    inLink: Boolean(link),
    inButton: Boolean(button),
    href: link ? link.getAttribute("href") : null,
    // Sem target no link, vale o do <base target> do documento (HTML: o
    // atributo do link, mesmo vazio, vence o do base).
    linkTarget: link
      ? link.hasAttribute("target")
        ? link.getAttribute("target")
        : (document.querySelector("base[target]")?.getAttribute("target") ??
          null)
      : null,
    cursor: shownStyle.cursor,
    color: hex(shownStyle.color),
    parentColor: shown.parentElement
      ? hex(getComputedStyle(shown.parentElement).color)
      : "",
    textDecoration: decoration,
    // Heurística: handler do React/Preact não aparece no DOM. `onclick` é o
    // caso explícito; cursor pointer fora de link/botão é o sinal de que
    // alguém tratou o clique (ou de que a página promete um clique que não há).
    hasClickHandler:
      typeof (el as HTMLElement).onclick === "function" ||
      el.hasAttribute("onclick") ||
      (s.cursor === "pointer" && !link && !button),
    inForm: Boolean(el.closest("form")),
    inputType: tag === "input" ? (el as HTMLInputElement).type : null,
    rect: {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + pageY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
    wrapper,
  };
}

/**
 * Foto do estado em volta do alvo, pra comparar antes/depois de um clique:
 * URL, foco, texto selecionado, hash do HTML do pai e diálogos abertos.
 */
export function clickSnapshotInPage(selector: string): ClickSnapshot {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    el = null;
  }
  // Pai = <body> num alvo raso: o teto evita hashear megabytes. As marcas do
  // próprio verificador (data-ux-anchor/hit/choice) saem antes do hash: o
  // teste de ponto grava uma entre o "antes" e o "depois", e sem tirar o
  // observe_click nunca diria "nada mudou".
  const near = el
    ? (el.parentElement ?? el).outerHTML
        .replace(/\sdata-ux-[\w-]+(="[^"]*")?/g, "")
        .slice(0, 200_000)
    : "";
  let h = 5381;
  for (let i = 0; i < near.length; i++) {
    h = (Math.imul(h, 33) ^ near.charCodeAt(i)) >>> 0;
  }
  let dialogs = 0;
  for (const d of Array.from(
    document.querySelectorAll(
      "dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true']",
    ),
  )) {
    const r = d.getBoundingClientRect();
    const s = getComputedStyle(d);
    if (
      r.width > 1 &&
      r.height > 1 &&
      s.display !== "none" &&
      s.visibility !== "hidden"
    )
      dialogs++;
  }
  return {
    url: location.href,
    activeTag: document.activeElement ? document.activeElement.localName : null,
    selection: String(window.getSelection() ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
    nearHtmlHash: el ? `${h.toString(36)}:${near.length}` : "",
    openDialogs: dialogs,
  };
}

/**
 * Acha a primeira opção DISPONÍVEL de tamanho ou de variação (cor), marca com
 * `data-ux-choice` e devolve o rótulo dela; null quando não acha o grupo ou
 * nada está disponível. NÃO clica: o clique sai do lado de fora, pela mesma
 * trava dos outros cliques (proibido + o que está por cima no ponto). O grupo
 * de tamanho usa as mesmas pistas de `measurePdpInPage` (3+ irmãos com texto de
 * tamanho); o de variação, um grupo de miniaturas com pista de cor.
 */
export function chooseOptionInPage(kind: "size" | "variant"): string | null {
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return (
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      Number(s.opacity) > 0.05
    );
  };
  const top = (el: Element): number =>
    Math.round(el.getBoundingClientRect().top + window.scrollY);
  // Texto visível, sem o conteúdo de SCRIPT/STYLE/NOSCRIPT/TEMPLATE: sites
  // TanStack embutem o JSON do evento de analytics DENTRO do botão, e o
  // textContent de "Adicionar à sacola" passava de 40 caracteres (14/11).
  // Mesmo corpo de `visibleTextOf` (testado fora do navegador).
  const visibleText = (node: Node): string => {
    let out = "";
    const walk = (n: typeof node): void => {
      if (n.nodeType === 3) out += n.nodeValue ?? "";
      if (n.nodeType !== 1) return;
      const tag = (n as { localName?: string }).localName ?? "";
      if (/^(script|style|noscript|template)$/i.test(tag)) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim();
  };
  const attr = (e: Element, n: string): string =>
    (e.getAttribute(n) ?? "").trim();
  const cls = (e: Element): string =>
    typeof e.className === "string" ? e.className : "";
  const sizeToken =
    /^(PP|P|M|G|GG|XG|XGG|XS|S|L|XL|XXL|U|UN|ÚNICO|UNICO|\d{2}|\d{1,2}(\.5)?)$/i;
  // Sem `variant` solto: design system usa "button--variant-primary".
  // Classe só vale INTEIRA ("color", "swatch"): `text-color-base` do Tailwind
  // não é grupo de cores. Rótulo (aria-label/title) e a legenda do grupo
  // ("Cor: Azul") valem por palavra.
  const colorClass =
    /^(cor|cores|colou?rs?|swatch(es)?|variac(ao|oes)|variaç(ão|ões))$/i;
  const colorText = /(\bcor(es)?\b|\bcolou?rs?\b|swatch|varia(ç|c(ao|oes)))/i;
  const hinted = (e: Element): boolean =>
    Array.from(e.classList).some((c) => colorClass.test(c)) ||
    colorText.test(`${attr(e, "aria-label")} ${attr(e, "title")}`);
  const unavailable = (e: Element): boolean => {
    if ((e as HTMLButtonElement).disabled) return true;
    if (attr(e, "aria-disabled") === "true") return true;
    if (
      /(disabled|unavailable|indispon|esgot|sold-?out|out-?of-?stock)/i.test(
        `${cls(e)} ${attr(e, "aria-label")} ${attr(e, "title")}`,
      )
    )
      return true;
    const input = e.querySelector("input");
    if (input && (input as HTMLInputElement).disabled) return true;
    const s = getComputedStyle(e);
    return (
      s.textDecorationLine.includes("line-through") || Number(s.opacity) < 0.5
    );
  };
  const selected = (e: Element): boolean => {
    if (attr(e, "aria-checked") === "true") return true;
    if (attr(e, "aria-selected") === "true") return true;
    const current = attr(e, "aria-current");
    if (current && current !== "false") return true;
    const input = e.querySelector("input");
    if (input && (input as HTMLInputElement).checked) return true;
    return /(\bactive\b|\bselected\b|--active|--selected|is-active|is-selected|\bchecked\b)/i.test(
      cls(e),
    );
  };
  const label = (e: Element): string => {
    const img = e.querySelector("img[alt]");
    return (
      attr(e, "aria-label") ||
      attr(e, "title") ||
      visibleText(e) ||
      (img ? attr(img, "alt") : "") ||
      attr(e, "value")
    ).slice(0, 60);
  };

  const all = Array.from(document.querySelectorAll("body *")).filter(visible);
  let group: Element | null = null;
  for (const el of all) {
    const kids = Array.from(el.children).filter(visible);
    if (kids.length < 2 || kids.length > 20) continue;
    const sizeHits = kids.filter((k) => sizeToken.test(visibleText(k))).length;
    let ok = false;
    if (kind === "size") {
      ok = kids.length >= 3 && sizeHits >= 3 && sizeHits >= kids.length * 0.6;
    } else {
      const caption = el.previousElementSibling
        ? visibleText(el.previousElementSibling).slice(0, 40)
        : "";
      const small = kids.filter((k) => {
        const r = k.getBoundingClientRect();
        return r.width <= 120 && r.height <= 120;
      }).length;
      ok =
        ([el, ...kids.slice(0, 3)].some(hinted) ||
          /^(cor|cores|colou?rs?)\b/i.test(caption)) &&
        small >= kids.length * 0.6 &&
        sizeHits < kids.length * 0.5;
    }
    if (ok && (!group || top(el) < top(group))) group = el;
  }
  for (const marked of Array.from(
    document.querySelectorAll("[data-ux-choice]"),
  )) {
    marked.removeAttribute("data-ux-choice");
  }
  if (!group) return null;
  for (const kid of Array.from(group.children).filter(visible)) {
    if (unavailable(kid) || selected(kid)) continue;
    const target = kid.matches("button, a, label, input, [role]")
      ? kid
      : (kid.querySelector(
          "button, a, label, input, [role='radio'], [role='option'], [role='button']",
        ) ?? kid);
    target.setAttribute("data-ux-choice", "1");
    return label(kid) || "(opção sem rótulo)";
  }
  return null;
}

/**
 * Rola o alvo pro meio da tela e espera a página reagir à rolagem: barra de
 * compra fixa que aparece ao rolar só existe depois de alguns quadros e da
 * transição dela. Roda ANTES de `clickPointInPage`, em outro evaluate — no
 * mesmo, o teste de ponto via a página de antes da barra entrar.
 */
export async function scrollToCenterInPage(selector: string): Promise<boolean> {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    el = null;
  }
  if (!el) return false;
  // "instant": com `scroll-behavior: smooth` a rolagem ainda estaria andando.
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  // Dois quadros (com teto: aba escondida não roda rAF) + a transição da barra.
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => {
      requestAnimationFrame(() => r(null));
      setTimeout(() => r(null), 100);
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  return true;
}

/**
 * Onde o clique vai cair e o que está lá (o alvo já rolado por
 * `scrollToCenterInPage`): pega o centro dele e pergunta à página quem está
 * por cima naquele ponto
 * (`elementFromPoint`). Esse elemento ganha `data-ux-hit`, pra checar se é
 * proibido. `covered` = o ponto cai em algo que não é o alvo nem filho dele
 * (barra de compra fixa por cima, modal) — clicar ali clicaria nele.
 */
export function clickPointInPage(selector: string): {
  found: boolean;
  covered: boolean;
  x: number;
  y: number;
} {
  for (const marked of Array.from(document.querySelectorAll("[data-ux-hit]"))) {
    marked.removeAttribute("data-ux-hit");
  }
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    el = null;
  }
  if (!el) return { found: false, covered: false, x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  if (hit) hit.setAttribute("data-ux-hit", "1");
  return {
    found: true,
    covered: !hit || !(hit === el || el.contains(hit)),
    x: Math.round(x),
    y: Math.round(y),
  };
}

// ── Camadas por cima da página (sonda de pop-up) ─────────────────────────────

/** Uma camada fixa aberta por cima da página, na 1ª tela. */
export interface OverlayReading {
  /** O texto da camada, até 100 caracteres. */
  text: string;
  /**
   * Quanto da 1ª tela ela COBRE À VISTA, em %: a caixa com fundo (a dela ou
   * a do maior filho com fundo). O invólucro do pop-up de uma loja é a tela
   * inteira e transparente; o que se vê é a caixa de ~65% (19/11).
   */
  area_pct: number;
  /** Topo e base da parte à vista, na tela (px). */
  top: number;
  bottom: number;
  /**
   * A camada inteira (com o fundo transparente) pega a tela quase toda e
   * recebe o toque: o resto da página não responde enquanto ela está aberta.
   */
  blocks_page: boolean;
  /** Uma película semitransparente escurece a tela inteira por trás dela. */
  dims_page: boolean;
  /** É diálogo (`role=dialog`, `aria-modal`, `<dialog>`)? */
  dialog: boolean;
}

export interface OverlaysReading {
  viewport: { width: number; height: number };
  overlays: OverlayReading[];
  /**
   * Por parte: o centro dela está na 1ª tela e uma camada fixa está por cima
   * (true), está na 1ª tela e nada a cobre (false), ou fora da 1ª tela / não
   * achada (null).
   */
  covered: Record<string, boolean | null>;
}

/**
 * Mede as camadas `position: fixed` abertas sobre a 1ª tela, numa página
 * aberta SEM fechar pop-up (keepOverlays). A captura de sempre fecha tudo
 * antes de medir e do print (dismissOverlaysInPage), então "o pop-up de
 * newsletter tampa a 1ª tela" nunca virava fato — a sonda é isto.
 *
 * Camada abaixo de 10% da tela (um selo, um botão de chat) fica de fora. A
 * camada dentro de outra camada também: conta a de fora.
 */
export function overlaysInPage(
  partSelectors: Record<string, string>,
): OverlaysReading {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const area = vw * vh;
  const shown = (el: Element) => {
    const s = getComputedStyle(el);
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number(s.opacity || "1") > 0.05
    );
  };
  const inView = (r: DOMRect) => {
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return w * h;
  };
  // Opacidade do fundo: 0 = transparente; uma película (scrim) fica entre
  // 0,05 e 0,6; caixa de verdade, acima disso (ou com imagem de fundo).
  const alpha = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.backgroundImage && s.backgroundImage !== "none") return 1;
    const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor);
    if (!m) return 0;
    const parts = m[1]!.split(",").map((x) => Number(x.trim()));
    return parts.length < 4 ? 1 : parts[3]!;
  };
  const opaque = (el: Element) => alpha(el) >= 0.6;
  const candidates: Array<{ el: Element; reading: OverlayReading }> = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (getComputedStyle(el).position !== "fixed" || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    const whole = inView(r);
    if (whole / area < 0.1) continue;
    // A parte à vista: a própria caixa, se tem fundo; senão o maior filho
    // com fundo (até 400 filhos olhados).
    let seen = opaque(el) ? r : null;
    if (!seen) {
      let best = 0;
      const kids = el.querySelectorAll("*");
      for (let i = 0; i < kids.length && i < 400; i++) {
        const k = kids[i]!;
        if (!opaque(k) || !shown(k)) continue;
        const kr = k.getBoundingClientRect();
        const a = inView(kr);
        if (a > best) {
          best = a;
          seen = kr;
        }
      }
    }
    const box = seen ?? r;
    const pct = Math.round((inView(box) / area) * 1000) / 10;
    if (pct < 10) continue;
    const blocks =
      whole / area >= 0.9 && getComputedStyle(el).pointerEvents !== "none";
    const dims = whole / area >= 0.9 && !opaque(el) && alpha(el) > 0.05;
    const text = ((el as HTMLElement).innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    const dialog =
      el.tagName === "DIALOG" ||
      el.getAttribute("role") === "dialog" ||
      el.getAttribute("aria-modal") === "true" ||
      !!el.querySelector("[role=dialog],[aria-modal=true],dialog");
    candidates.push({
      el,
      reading: {
        text,
        area_pct: pct,
        top: Math.round(Math.max(0, box.top)),
        bottom: Math.round(Math.min(vh, box.bottom)),
        blocks_page: blocks,
        dims_page: dims,
        dialog,
      },
    });
  }
  const outer = candidates.filter(
    (c) => !candidates.some((o) => o !== c && o.el.contains(c.el)),
  );
  const covered: Record<string, boolean | null> = {};
  for (const [part, selector] of Object.entries(partSelectors)) {
    let target: Element | null = null;
    try {
      target = document.querySelector(selector);
    } catch {
      target = null;
    }
    if (!target) {
      covered[part] = null;
      continue;
    }
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (r.width < 1 || r.height < 1 || cx < 0 || cx > vw || cy < 0 || cy > vh) {
      covered[part] = null;
      continue;
    }
    const hit = document.elementFromPoint(cx, cy);
    covered[part] =
      !!hit &&
      !target.contains(hit) &&
      outer.some((c) => c.el === hit || c.el.contains(hit));
  }
  return {
    viewport: { width: vw, height: vh },
    overlays: outer
      .map((c) => c.reading)
      .sort((a, b) => b.area_pct - a.area_pct)
      .slice(0, 4),
    covered,
  };
}
