/**
 * Functions that run INSIDE the page via `page.evaluate`. Each is serialized
 * with `fn.toString()`, so it can only use its own body: no imports, module
 * constants or outside helpers (a violation is a browser `ReferenceError`, not a
 * type error). Heuristics are store-agnostic and return `null` when nothing matches.
 */

import type { ClickSnapshot, ElementFacts } from "./verify/safety.ts";

// ── Visible text ─────────────────────────────────────────────────────────────

/** The minimum of a DOM node that `visibleTextOf` reads (a real Node works). */
export interface TextTreeNode {
  nodeType: number;
  nodeValue: string | null;
  localName?: string;
  firstChild: TextTreeNode | null;
  nextSibling: TextTreeNode | null;
}

/**
 * Text of a node without SCRIPT, STYLE, NOSCRIPT and TEMPLATE content. Does NOT
 * run in the page: it is the testable copy of the `visibleText` that each
 * in-page function declares internally (serialization rule above); the test
 * checks that the bodies are identical. Needed because a buy button's
 * textContent can carry an embedded event JSON before the label.
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
 * Display label: visible text without scripts or hidden subtrees (tooltips).
 * Display only; the click guard reads the full text (`visibleTextOf`).
 * Copied as `const labelText` in the page functions (the test checks it).
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

/** The minimum of an element that `navigationOf` reads (a real Element works). */
export interface ActionNode {
  localName: string;
  getAttribute(name: string): string | null;
  closest(selector: string): ActionNode | null;
}

/**
 * Where a click takes the browser (path, or host+path for another site), or ""
 * if the page does not change: a real link or a submit button in a form.
 * Deco Analytics counts a click as dead when the page does not change within
 * 1 s, so a slower navigation must not be read as dead.
 * Copied as `const navigationOf` in `elementLabelsInPage` (the test checks it).
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

// ── Dismiss banners ──────────────────────────────────────────────────────────

/**
 * Accepts cookies and hides modals covering the page. Only fixed layers covering
 * over half the screen go; the header and sticky buy bar stay because they are measured.
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
          /* element vanished midway */
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
  // Only unlock what the modal locked: forcing `auto` on <html> moves scrolling to <body> and breaks `scrollTo`.
  for (const el of [document.documentElement, document.body]) {
    if (/(hidden|clip)/.test(getComputedStyle(el).overflowY)) {
      el.style.setProperty("overflow", "auto", "important");
    }
  }
}

// ── Scroll the page ──────────────────────────────────────────────────────────

/**
 * The element that scrolls the page when it is not the window (<body> with
 * overflow, or the largest such element covering the screen); `null` = window.
 * Copied as `const pageScroller` in each in-page function that scrolls or measures (the test checks it).
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
    // Visible and covering the screen: an off-screen drawer is not the page.
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
 * Scrolls to `y` (px from the document top) and returns the scroll reached,
 * scrolling the window and then the page scroller. "instant" because
 * `scroll-behavior: smooth` would leave `scrollY` at 0. The only scroll path.
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
      // Visible and covering the screen: an off-screen drawer is not the page.
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

/** Top of `selector` in document px, or `null` if it matches nothing. */
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
      // Visible and covering the screen: an off-screen drawer is not the page.
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

// ── Price and the "this item's" button ─────────────────────────────────────

/**
 * THIS product's price from what the page declares: JSON-LD `Product`, then
 * `[itemprop=price]`/meta, then the dataLayer `view_item`. `from: null` = not found.
 * Copied as `const productPriceValues` in `measurePdpInPage` (the test checks it).
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
  // List price (struck-through) only counts when no sale price shows.
  const list: number[] = [];
  const add = (v: unknown, into: number[] = out): void => {
    let n = Number.NaN;
    if (typeof v === "number") n = v;
    else if (typeof v === "string") {
      const t = v.replace(/[^\d.,]/g, "");
      // "1.998" is thousands, not decimal: a dot followed by 3 digits at the end.
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
      // List price, if present (the "old" price of the old/new pair).
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
      /* broken JSON-LD: move on to the next */
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
 * Does the text show one of these values in the page's money format ("R$ 244,30",
 * "1.299,90")? It does not match part of another number ("1.244,30").
 * Copied as `const moneyHasValue` in `measurePdpInPage`.
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
 * Buy button text: short, with a buy verb, and not a wishlist or favorite.
 * Copied as `const isBuyText` in `measurePdpInPage`.
 */
export function isBuyText(text: string): boolean {
  if (text.length > 40) return false;
  if (/(favorit|desejo|wishlist|lista)/i.test(text)) return false;
  return /(adicionar|comprar|sacola|carrinho|add to (bag|cart)|buy now|añadir|comprar agora)/i.test(
    text,
  );
}

/**
 * Indices of the texts showing this item's price: the sale price outside
 * struck-through text first, the list price only if no sale price shows.
 * Copied as `const priceMatches` in `measurePdpInPage`.
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
 * Index of the topmost candidate outside a sticky bar (`pinned`), or -1. On a
 * height tie, `prefer` picks the smallest element (price) or the largest (button).
 * Copied as `const pickTopCandidate` in `measurePdpInPage`.
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

// ── Measure the PDP ─────────────────────────────────────────────────────────

export interface MeasuredPdp {
  page_height: number;
  positions: {
    price: number | null;
    size_selector: number | null;
    buy_button: number | null;
    shipping: number | null;
    first_recommendation: number | null;
  };
  /** Selectors of the elements found; the mockup uses them to know where to change things. */
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
  /** Probe debugging: candidate counts and where the price value came from. */
  candidates?: {
    price: number;
    price_from: "json-ld" | "meta" | "dataLayer" | "fonte";
    buy_button: number;
  };
}

/**
 * Where price, size, buy button, shipping and first recommendation are (px from
 * the document top), whether a sticky buy bar exists, and what is on the first
 * screen. Needs the page scrolled once (lazy-load).
 */
export async function measurePdpInPage(opts?: {
  /** Skips scrolling, which would trigger scroll pop-ups and lazy-load; `has_sticky_buy` is then false. */
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
  // Document position = screen top + the page scroller's offset.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visible and covering the screen: an off-screen drawer is not the page.
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
  // Scrolls through the same path as `scrollPageToInPage`.
  const scrollPage = (y: number): void => {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    scroller?.scrollTo({
      top: Math.max(0, y - window.scrollY),
      left: 0,
      behavior: "instant",
    });
  };
  // Visible text minus SCRIPT/STYLE/NOSCRIPT/TEMPLATE; same body as `visibleTextOf`.
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
  // Add :nth-of-type when the short path also matches another element.
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
      /* class with a character the selector does not accept: use position */
    }
    return build(true);
  };

  const all = Array.from(document.querySelectorAll("body *")).filter(visible);

  // Outside a sticky bar: a `fixed` ancestor, or a `sticky` smaller than half the screen. The site header is the topmost visible header/nav outside main/article.
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
  // On screen horizontally: a carousel hides off-screen cards.
  const onScreenX = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.left < window.innerWidth;
  };
  // Same bodies as `productPriceValues`, `moneyHasValue`, `pickTopCandidate`, `isBuyText` and `priceMatches`.
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
    // List price (struck-through) only counts when no sale price shows.
    const list: number[] = [];
    const add = (v: unknown, into: number[] = out): void => {
      let n = Number.NaN;
      if (typeof v === "number") n = v;
      else if (typeof v === "string") {
        const t = v.replace(/[^\d.,]/g, "");
        // "1.998" is a thousands separator, not a decimal: a dot followed by 3 digits at the end.
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
        // List price, if present (the "old" price of the old/new pair).
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
        /* broken JSON-LD: move on to the next */
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

  // Price: this product's declared price in the page's format, the highest visible one outside a sticky bar; without it, the largest font in the top half.
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
  // Struck-through: the "old" price of the old/new pair (line-through, or inside <s>/<del>).
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
  // The innermost one: a "name + price" block also shows the value.
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

  // Buy button: the topmost visible one outside a sticky bar. Candidates: button/a/[role=button] or cursor pointer/onclick, with short buy text and at least 60×28.
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
  // Nested: the semantic one wins over cursor (inherited); between cursor ones, the outer.
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
  // Only a sticky bar with a button: fall back to the largest buy button.
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

  // Size selector: 3+ siblings whose text is a size.
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

  // Shipping: ZIP field or delivery text near the product, closest to the buy button (or price) so a rotating top promo bar does not win.
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
  // Short text and a leaf element (or only inline children), so a wrapper containing the text does not count.
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

  // First recommendation: a showcase title below the buy button.
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
  // No matching title: the first block below the buy button with 3+ distinct product cards.
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
    // Only card links with a 80px+ photo; a color swatch also points to another /p.
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

  // Sticky bar: scroll to 60% and look for a visible buy button in a fixed/sticky ancestor; skipped with `skipScroll`.
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

  // Display label without hidden subtrees (tooltips); same body as `labelTextOf`.
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
  // What is on the first screen, in order, as short text.
  const outline: string[] = [];
  const seen = new Set<string>();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight) continue;
    const tag = el.tagName.toLowerCase();
    const isLeaf = el.children.length === 0;
    if (tag === "img" && r.width * r.height > window.innerWidth * 120) {
      // A carousel stacks N photos in the same spot; one line is enough.
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

/** Measurements of a non-PDP page (home, category, search). */
export interface MeasuredSitePage {
  page_height: number;
  /** Page parts (px from the document top). NULL = not found. */
  positions: Record<string, number | null>;
  selectors: Record<string, string | null>;
  above_fold_outline: string[];
  /** Numbers and yes/no facts of the page (cards on the first screen, total results…). */
  facts: Record<string, number | boolean | string | null>;
}

/**
 * Measures home, category or search: hero, showcases, first card, filter, sort,
 * search and menu positions, plus facts on whether the product is findable.
 * A card is a PDP-pattern link with a photo; its container is the nearest list-item ancestor.
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
  // Document position = screen top + the page scroller's offset.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visible and covering the screen: an off-screen drawer is not the page.
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
  // Scrolls through the same path as `scrollPageToInPage`.
  const scrollPage = (y: number): void => {
    window.scrollTo({ top: y, left: 0, behavior: "instant" });
    scroller?.scrollTo({
      top: Math.max(0, y - window.scrollY),
      left: 0,
      behavior: "instant",
    });
  };
  // Visible text minus SCRIPT/STYLE/NOSCRIPT/TEMPLATE; same body as `visibleTextOf`.
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
  // Add :nth-of-type when the short path also matches another element.
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
      /* class with a character the selector does not accept: use position */
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

  // Product cards: a link to a PDP with a photo, one per product.
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
    // The card is the smallest ancestor with photo and price (up to 6 levels); without a price, the nearest list item.
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
  // A card hidden in a carousel does not count.
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
  // Showcase = the nearest ancestor of a card that gathers 3+ cards.
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

  // Parts.
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
    // The showcase title, if there is a heading above the first card.
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
  // Only count "no results" without cards: the empty-state text can stay in the DOM.
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

  // Sticky filter on scroll: scroll halfway and check whether the button stays on screen.
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

  // Display label without hidden subtrees (tooltips); same body as `labelTextOf`.
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
  // What is on the first screen, in order, as short text.
  const outline: string[] = [];
  const seen = new Set<string>();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight) continue;
    const tag = el.tagName.toLowerCase();
    const isLeaf = el.children.length === 0;
    if (tag === "img" && r.width * r.height > window.innerWidth * 120) {
      // A carousel stacks N photos in the same spot; one line is enough.
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

/** Mirror of DesignSystem (types.ts) without the fields the server fills in. */
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
 * Reads the page's design system: CSS variables, palette, fonts, typography and
 * the style of the components a PDP mockup reuses (button, size chip, badge, field).
 */
export function extractDesignSystemInPage(): ExtractedDesignSystem {
  // Window or <body> scroller; same body as `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visible and covering the screen: an off-screen drawer is not the page.
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
  // Visible text minus SCRIPT/STYLE/NOSCRIPT/TEMPLATE; same body as `visibleTextOf`.
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
  // Tailwind's `rounded-full` computes to ~3.35544e+07px; report it as "pill".
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

  // CSS variables: Chrome enumerates custom properties in the computed style.
  const vars: Record<string, string> = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootStyle.length && Object.keys(vars).length < 80; i++) {
    const name = rootStyle[i]!;
    if (!name.startsWith("--")) continue;
    const value = rootStyle.getPropertyValue(name).trim();
    if (value && value.length < 80) vars[name] = value;
  }

  // Palette and fonts by frequency.
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

  // Components.
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

  // Typography.
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

  // Buy block: the union of price and button (and whatever is between them).
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

// ── DOM excerpt for the mockup ───────────────────────────────────────────────

/** Condensed HTML of the PDP core (price to recommendation) for the mockup patch: no script/svg, only class/id/role/aria attributes, short text. */
export function domExcerptInPage(selector: string | null): string {
  const anchor =
    (selector ? document.querySelector(selector) : null) ??
    document.querySelector("main") ??
    document.body;
  // Climb to an ancestor big enough to contain the buy block.
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

// ── Inject the patch ─────────────────────────────────────────────────────────

export interface MockupPatch {
  /** CSS added to the page (can override the store's classes). */
  css: string;
  /** HTML insertions relative to an existing element. */
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
  /** Elements to hide (e.g. the old block the new one replaces). */
  hide: string[];
  /** Scroll here before the "After" screenshot (px from the top). */
  scroll_to: number | null;
}

/**
 * Applies the patch to the real page and returns how many changes took effect;
 * the server rejects an "After" where nothing did. A CSS rule only counts if it
 * matches an element after the insertions.
 */
export function applyPatchInPage(patch: MockupPatch): {
  applied: number;
  missing: string[];
  /** CSS selectors that matched nothing (up to 10). */
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
  // State (:hover…) and pseudo-elements do not match in querySelector; check the base element.
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
        // @media / @supports: count the rules inside.
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  if (style.sheet) visit(style.sheet.cssRules);
  return { applied, missing, css_unmatched: cssUnmatched };
}

// ── Block map for the mockup ─────────────────────────────────────────────────

/**
 * The large blocks of the first two screens as text for the mockup prompt:
 * selector and geometry. The photo gallery is included because the DOM excerpt starts at the buy block.
 */
export interface LayoutBlock {
  /** Selector — position — size, as text for the prompt. */
  line: string;
  /** The element's full `class`: it is how the store's code is found. */
  class_name: string;
}

export function layoutOutlineInPage(): LayoutBlock[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const box = (el: Element) => el.getBoundingClientRect();
  // Window or <body> scroller; same body as `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visible and covering the screen: an off-screen drawer is not the page.
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
  // Short selector for only this element: id if possible, else tag.classes with :nth-of-type.
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
        /* invalid selector: keep climbing */
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
    // A wrapper the same size as its parent adds nothing: keep the outer one.
    const parent = el.parentElement;
    if (parent && parent !== document.body && same(box(parent), r)) continue;
    const fixed = getComputedStyle(el).position;
    // innerText, not textContent: the latter brings inline <style> CSS along.
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

// ── Find PDP, showcase and search in an arbitrary store (benchmark) ──────────

/**
 * The page's links as the customer sees them: absolute href, page region, text
 * and whether they have a photo. `classifyStoreLinks` decides PDP vs showcase outside the page.
 * `text` and `heading` tell whether a search answered "no results" and for the term.
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

/** What finds the store's search: forms (action, named inputs) and the start of the HTML; `searchRoutes` picks the route. */
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

/** Is the open page a PDP? JSON-LD `Product`/`ProductGroup`, schema.org/Product microdata or og:type product. */
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

/** What `classifyBotWall` (browser.ts) needs to detect an anti-bot wall: link count and the start of the HTML and text. */
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

// ── Name the heatmap elements ────────────────────────────────────────────────

/**
 * For each requested `root|el` (Deco Analytics `hmElements`), what that element
 * is on this page: tag, text, position. The collector sends only a path hash, so
 * the SAME hash is computed on the live DOM and matched.
 *
 * Copy of `shared/anchor.ts` in decocms/analytics (ANCHOR_VERSION 1); if the
 * version bumps, elements go unlabeled rather than mislabeled. Matched elements
 * get `data-ux-anchor="<root>|<el>"` for the verifier; old marks are cleared first.
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
  // Window or <body> scroller; same body as `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visible and covering the screen: an off-screen drawer is not the page.
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
  // Visible text minus SCRIPT/STYLE/NOSCRIPT/TEMPLATE; same body as `visibleTextOf`.
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
  // Display label without hidden subtrees (tooltips); same body as `labelTextOf`.
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
  // Same body as `navigationOf` (tested outside the browser).
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
    // innerText of hidden elements falls back to textContent (with <script> JSON): a fully hidden element has no label, so the full text applies.
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
    // Hidden on load, in a panel another click opens: its y is not a page position.
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

// ── Hypothesis verifier ──────────────────────────────────────────────────────

/**
 * What a verifier target is and looks like: tag, clickable text, colors, cursor,
 * underline, link/button/form context. Feeds `inspect` and `forbiddenReason`
 * (verify/safety.ts); an invalid selector returns `found: false`.
 */
export function elementFactsInPage(selector: string): ElementFacts {
  // Display label without hidden subtrees (tooltips); same body as `labelTextOf`.
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
  // Window or <body> scroller; same body as `pageScrollerInPage`.
  const pageScroller = (): Element | null => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scrolls = (el: Element): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (el.clientHeight < vh * 0.8 || el.clientWidth < vw * 0.8) return false;
      const s = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(s.overflowY)) return false;
      if (s.position === "fixed") return false;
      // Visible and covering the screen: an off-screen drawer is not the page.
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
  // Visible text minus SCRIPT/STYLE/NOSCRIPT/TEMPLATE; same body as `visibleTextOf`.
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
  // The forbidden-text check uses the containing clickable's text: an icon inside "Adicionar à sacola" clicks the button.
  const clickable =
    el.closest("button, a[href], [role='button'], label, summary") ?? el;
  // Visible text AND labels together: an icon-only button has the SVG <title> as text and the real label in aria-label.
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
  // A <button> without type inside a <form> IS a submit (HTML default).
  const type = btn
    ? btn.form
      ? btn.type
      : btn.getAttribute("type")
    : el.getAttribute("type");
  // A parent <a>'s underline does not show in the child's computed style.
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
  // Zero-height wrapper: size, color and cursor come from the largest visible child; text, link and click guard stay the target's.
  const own = el.getBoundingClientRect();
  const scroller = pageScroller();
  const pageY =
    window.scrollY + (scroller?.contains(el) ? scroller.scrollTop : 0);
  let shown: Element = el;
  let wrapper: ElementFacts["wrapper"] = null;
  if (own.width < 2 || own.height < 2) {
    // Only children that really show: a closed accordion has sized children under height:0 overflow:hidden. A clip between child and target counts unless a fixed element escapes it, and the child must fall inside the document (or the screen, if fixed).
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
      // Clip on the path to the target (inclusive), below the first fixed element.
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
      // Inside the screen (fixed) or the document (the rest).
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
    // Whole text: a forbidden label after the 200th character still counts.
    text,
    label: labelText(el, hiddenNode),
    role: el.getAttribute("role"),
    type,
    inLink: Boolean(link),
    inButton: Boolean(button),
    href: link ? link.getAttribute("href") : null,
    // Without a link target, the document's <base target> applies (an empty link attribute still wins).
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
    // Heuristic: React/Preact handlers are not in the DOM; `onclick` is explicit, and cursor pointer outside a link/button signals a handled click.
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

/** State around the target, to compare before/after a click: URL, focus, selection, parent HTML hash, open dialogs. */
export function clickSnapshotInPage(selector: string): ClickSnapshot {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    el = null;
  }
  // Parent = <body> for a shallow target: cap the size hashed. The verifier's own marks are stripped first so observe_click can say "nothing changed".
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
 * Finds the first AVAILABLE size or variation (color) option, marks it
 * `data-ux-choice` and returns its label; null if none. Does NOT click: the click
 * goes through the same guard as the others. Uses the same cues as `measurePdpInPage`.
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
  // Visible text minus SCRIPT/STYLE/NOSCRIPT/TEMPLATE; same body as `visibleTextOf`.
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
  // No bare `variant` (design systems use "button--variant-primary"); a class counts only WHOLE ("color", "swatch"), labels by word.
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
 * Scrolls the target to mid-screen and waits for the page to react (a sticky buy
 * bar needs a few frames). Runs BEFORE `clickPointInPage`, in another evaluate.
 */
export async function scrollToCenterInPage(selector: string): Promise<boolean> {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    el = null;
  }
  if (!el) return false;
  // "instant": with `scroll-behavior: smooth` the scroll would still be moving.
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  // Two frames (capped: hidden tabs skip rAF) plus the bar's transition.
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
 * Where the click lands and what is there (target already scrolled): takes its
 * center and finds the element on top (`elementFromPoint`), marked `data-ux-hit`.
 * `covered` = the point falls on something that is not the target or its child.
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

// ── Layers over the page (popup probe) ───────────────────────────────────────

/** An open fixed layer over the page, on the first screen. */
export interface OverlayReading {
  /** The layer's text, up to 100 characters. */
  text: string;
  /** How much of the first screen it VISIBLY covers, in %: the box with a background (its own or the largest child's). */
  area_pct: number;
  /** Top and bottom of the visible part, on screen (px). */
  top: number;
  bottom: number;
  /** The whole layer, even if transparent, takes almost the whole screen and receives touches. */
  blocks_page: boolean;
  /** A semi-transparent film darkens the whole screen behind it. */
  dims_page: boolean;
  /** Is it a dialog (`role=dialog`, `aria-modal`, `<dialog>`)? */
  dialog: boolean;
}

export interface OverlaysReading {
  viewport: { width: number; height: number };
  overlays: OverlayReading[];
  /** Per part: its center is on the first screen with a fixed layer on top (true), uncovered (false), or off screen/not found (null). */
  covered: Record<string, boolean | null>;
}

/**
 * Measures `position: fixed` layers open over the first screen on a page opened
 * WITHOUT closing pop-ups (keepOverlays). Layers under 10% of the screen are
 * ignored, and nested layers count only as the outer one.
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
  // Background opacity: 0 = transparent, 0.05–0.6 = scrim, above (or with a background image) = a real box.
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
    // The visible part: the box itself if it has a background, else the largest child with one (up to 400 examined).
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
