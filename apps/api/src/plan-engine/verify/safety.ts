/**
 * What the verifier must not do on the live store: send tracking events or
 * click something that changes the store. Pure decisions, testable outside the
 * browser; element facts come from `elementFactsInPage` (page-scripts.ts).
 */

/**
 * Is the request a tracking one? Blocked during verification. Serialized for
 * the browser like the page scripts, so it uses nothing outside its body.
 */
export function isTrackingRequest(url: string): boolean {
  // Host (or subdomain suffix) -> path that must match; "" = any.
  const TRACKING: ReadonlyArray<{ host: string; path: string }> = [
    { host: "analytics.decocdn.com", path: "" },
    { host: "google-analytics.com", path: "" },
    { host: "googletagmanager.com", path: "" },
    { host: "d.lilstts.com", path: "" },
    { host: "facebook.com", path: "/tr" },
    { host: "connect.facebook.net", path: "" },
  ];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return TRACKING.some(
    (t) =>
      (host === t.host || host.endsWith(`.${t.host}`)) &&
      (!t.path || u.pathname === t.path || u.pathname.startsWith(`${t.path}/`)),
  );
}

/** Targets that navigate in the tab itself (on a non-iframe page). */
const SAME_TAB = new Set(["", "_self", "_top", "_parent"]);

/**
 * Does the link open another tab? Any window name counts, not just `_blank`:
 * a new tab is born without the per-page tracking block.
 */
export function opensNewTab(target: string | null): boolean {
  return !SAME_TAB.has((target ?? "").trim().toLowerCase());
}

/** Mirror of `elementFactsInPage`'s return. */
export interface ElementFacts {
  found: boolean;
  tag: string;
  /** FULL text of the containing clickable (or its own); cut only when displaying. */
  text: string;
  /** The target's own label, for display only; the click lock reads `text`. */
  label?: string;
  role: string | null;
  type: string | null;
  inLink: boolean;
  inButton: boolean;
  href: string | null;
  /** The link's effective `target`: its own or the document's `<base target>`. */
  linkTarget: string | null;
  cursor: string;
  color: string;
  parentColor: string;
  textDecoration: string;
  /** Heuristic: `onclick` present or pointer cursor outside a link/button. */
  hasClickHandler: boolean;
  inForm: boolean;
  inputType: string | null;
  /** Document coordinates (CSS px), not the screen's. */
  rect: { x: number; y: number; width: number; height: number } | null;
  /**
   * Set when the target is a zero-size wrapper: `rect`, color and cursor come
   * from its largest visible child; text, link and click lock stay the target's.
   */
  wrapper?: { width: number; height: number; child: string } | null;
}

const BUY =
  /(adicionar|comprar|sacola|carrinho|add to (bag|cart)|buy now|añadir)/i;
// "Payment methods" opens an installments modal on the PDP: only "go to payment".
const CHECKOUT =
  /(finalizar (a )?compra|checkout|fechar pedido|ir (para o|pro) pagamento)/i;
const LOGIN =
  /(\bentrar\b|\blogin\b|\blog in\b|\bsign in\b|minha conta|cadastr|\blogout\b|\bsair\b)/i;
const CEP = /(\bcep\b|postal|\bzip\b|frete|shipping)/i;
// A newsletter field is usually `type=text` with an e-mail name/placeholder.
const EMAIL = /e-?mail/i;
const SECRET_INPUTS = new Set(["email", "password"]);
const RISKY_HREF =
  /\/(checkout|cart|carrinho|login|account|minha-conta|conta|logout|sair)(\/|$|\?|#)/i;

/**
 * Why clicking here would change the store; null = safe to click. Conservative:
 * a false "can't" costs one untested check, a false "can" hits a real session.
 */
export function forbiddenReason(f: ElementFacts): string | null {
  const text = f.text ?? "";
  // `<input type=image>` also submits the form.
  const type = f.type?.toLowerCase() ?? "";
  if (type === "submit" || type === "image")
    return "botão de envio de formulário";
  const input = f.inputType?.toLowerCase() ?? "";
  if (SECRET_INPUTS.has(input))
    return input === "email" ? "campo de e-mail" : "campo de senha";
  if (f.tag === "input" && EMAIL.test(text)) return "campo de e-mail";
  if (f.tag === "input" && CEP.test(text)) return "campo de CEP";
  if (CHECKOUT.test(text)) return "finalizar compra";
  if (BUY.test(text)) return "botão de compra";
  if (LOGIN.test(text)) return "login";
  if (f.href) {
    let path = f.href;
    try {
      const u = new URL(f.href, "https://x.invalid");
      path = u.pathname + u.search + u.hash;
    } catch {
      /* odd relative href: test the raw string */
    }
    if (RISKY_HREF.test(path)) return "link pra sacola, checkout ou conta";
  }
  return null;
}

/** Page state around a target before and after a click (`clickSnapshotInPage`). */
export interface ClickSnapshot {
  url: string;
  /** Tag of the focused element (`document.activeElement`). */
  activeTag: string | null;
  /** Text selected on the page, up to 200 chars. */
  selection: string;
  /** Hash of the target parent's outerHTML: changes if the click opened/swapped something there. */
  nearHtmlHash: string;
  /** Visible dialogs/modals. */
  openDialogs: number;
}
