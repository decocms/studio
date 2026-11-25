/**
 * O que o verificador NÃO pode fazer na loja no ar: mandar evento de rastreio
 * (um teste nosso viraria clique de cliente no heatmap e no GA4) e clicar em
 * algo que mexe na loja (sacola, checkout, login, formulário).
 *
 * Decisões puras, pra testar fora do navegador; os fatos do elemento vêm de
 * `elementFactsInPage` (page-scripts.ts).
 */

/** Host (ou sufixo de subdomínio) → caminho que precisa casar; "" = qualquer. */
const TRACKING: ReadonlyArray<{ host: string; path: string }> = [
  { host: "analytics.decocdn.com", path: "" },
  { host: "google-analytics.com", path: "" },
  { host: "googletagmanager.com", path: "" },
  { host: "d.lilstts.com", path: "" },
  { host: "facebook.com", path: "/tr" },
  { host: "connect.facebook.net", path: "" },
];

/** A requisição é de rastreio? Bloqueada durante a verificação. */
export function isTrackingRequest(url: string): boolean {
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

/** Os targets que navegam na própria aba (numa página que não é iframe). */
const SAME_TAB = new Set(["", "_self", "_top", "_parent"]);

/**
 * O link abre outra aba? `_blank` e também qualquer nome de janela
 * (`target="produto"`): a aba nova nasce sem o bloqueio de rastreio, que é
 * por página.
 */
export function opensNewTab(target: string | null): boolean {
  return !SAME_TAB.has((target ?? "").trim().toLowerCase());
}

/** Espelho do retorno de `elementFactsInPage`. */
export interface ElementFacts {
  found: boolean;
  tag: string;
  /** Texto INTEIRO do clicável que o contém (ou do próprio); corte só na exibição. */
  text: string;
  /**
   * Rótulo do próprio alvo, sem sub-árvore escondida (tooltip): só pra
   * exibir. A trava de clique lê `text` (revisão, 14/11).
   */
  label?: string;
  role: string | null;
  type: string | null;
  inLink: boolean;
  inButton: boolean;
  href: string | null;
  /**
   * `target` efetivo do link: o do próprio `<a>` ou, sem ele, o do
   * `<base target>` do documento (ver `opensNewTab`).
   */
  linkTarget: string | null;
  cursor: string;
  color: string;
  parentColor: string;
  textDecoration: string;
  /** Heurística: `onclick` presente ou cursor pointer fora de link/botão. */
  hasClickHandler: boolean;
  inForm: boolean;
  inputType: string | null;
  /** Coordenadas do documento (px CSS), não da tela. */
  rect: { x: number; y: number; width: number; height: number } | null;
  /**
   * O alvo é um invólucro de tamanho zero (largura ou altura < 2) e `rect`,
   * cor e cursor são do maior filho visível dele. Um pop-up de newsletter
   * pode medir 390×0 aberto: quem aparece é o filho `position: fixed`.
   * O texto, o link e a trava de clique continuam sendo do alvo.
   */
  wrapper?: { width: number; height: number; child: string } | null;
}

const BUY =
  /(adicionar|comprar|sacola|carrinho|add to (bag|cart)|buy now|añadir)/i;
// "Formas de pagamento" abre modal de parcelamento na PDP: só "ir pro pagamento".
const CHECKOUT =
  /(finalizar (a )?compra|checkout|fechar pedido|ir (para o|pro) pagamento)/i;
const LOGIN =
  /(\bentrar\b|\blogin\b|\blog in\b|\bsign in\b|minha conta|cadastr|\blogout\b|\bsair\b)/i;
const CEP = /(\bcep\b|postal|\bzip\b|frete|shipping)/i;
// Newsletter costuma ser `type=text` com name/placeholder de e-mail.
const EMAIL = /e-?mail/i;
const SECRET_INPUTS = new Set(["email", "password"]);
const RISKY_HREF =
  /\/(checkout|cart|carrinho|login|account|minha-conta|conta|logout|sair)(\/|$|\?|#)/i;

/**
 * Por que clicar aqui mexeria na loja; null = pode clicar. Conservador de
 * propósito: um falso "não pode" custa um teste `nao_testou`, um falso "pode"
 * põe produto na sacola de uma sessão de verdade ou dispara um formulário.
 */
export function forbiddenReason(f: ElementFacts): string | null {
  const text = f.text ?? "";
  // `<input type=image>` também envia o formulário.
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
      /* href relativo esquisito: testa a string crua */
    }
    if (RISKY_HREF.test(path)) return "link pra sacola, checkout ou conta";
  }
  return null;
}

/**
 * Estado da página em volta de um alvo, antes e depois de um clique
 * (`clickSnapshotInPage`). `describeClickChange` (live.ts) compara os dois.
 */
export interface ClickSnapshot {
  url: string;
  /** Tag do elemento com foco (`document.activeElement`). */
  activeTag: string | null;
  /** Texto selecionado na página, até 200 chars. */
  selection: string;
  /** Hash do outerHTML do pai do alvo: muda se o clique abriu/trocou algo ali. */
  nearHtmlHash: string;
  /** Diálogos/modais visíveis. */
  openDialogs: number;
}
