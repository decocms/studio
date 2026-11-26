/**
 * Etapa "loja no ar" do verificador: roda os passos de um teste na PDP de
 * verdade e conta o que viu. Não decide nada — o veredito por teste
 * (confirma/desmente) é do juiz, que compara `observed` com
 * `confirms_if`/`refutes_if`. Daqui só sai `nao_decidiu` (rodou) ou
 * `nao_testou` (não deu pra rodar: alvo sumido, alvo proibido, passo quebrou).
 *
 * O rastreio da loja fica bloqueado durante o teste (o clique nosso não pode
 * virar clique de cliente no heatmap), e nada que mexa na loja é clicado.
 */

import { sleep } from "@decocms/shared/std";
import { openPage, screenshotClip, storeImage } from "../browser.ts";
import {
  chooseOptionInPage,
  clickPointInPage,
  clickSnapshotInPage,
  dismissOverlaysInPage,
  elementFactsInPage,
  elementLabelsInPage,
  measurePdpInPage,
  measureSitePageInPage,
  scrollToCenterInPage,
} from "../page-scripts.ts";
import { PART_WORD } from "../page-types.ts";
import type { BrowserPage, BrowserPort, MediaStore } from "../ports.ts";
import type { PageCapture, UxDevice, UxPart } from "../types.ts";
import {
  type ClickSnapshot,
  type ElementFacts,
  forbiddenReason,
  isTrackingRequest,
  opensNewTab,
} from "./safety.ts";
import {
  type CheckRun,
  MAX_WAIT_MS,
  type VerifyCheck,
  type VerifyTarget,
} from "./types.ts";

/** Teto do relato: vai inteiro pro prompt do juiz. */
const MAX_OBSERVED_CHARS = 1200;

type PartKey = UxPart;

const PART_NAMES: Record<PartKey, string> = {
  ...PART_WORD,
  first_recommendation: "primeira recomendação",
};

/** O alvo não tem área visível nesta tela (escondido, ou invólucro sem filho visível). */
export function isHiddenTarget(facts: ElementFacts): boolean {
  const r = facts.rect;
  return !r || r.width < 2 || r.height < 2;
}

/**
 * Seletor do alvo na página aberta. Elemento da Deco Analytics → a marca que
 * `elementLabelsInPage` grava; parte → o seletor medido na captura (null se a
 * captura não achou aquela parte).
 */
export function selectorFor(
  target: VerifyTarget,
  capture: PageCapture,
): string | null {
  if (target.kind === "element") {
    return `[data-ux-anchor="${target.key.replace(/["\\]/g, "\\$&")}"]`;
  }
  return capture.selectors?.[target.part] ?? null;
}

/** Seletores medidos na página do teste (`measurePdpInPage`), por parte. */
type FreshSelectors = Partial<Record<PartKey, string | null>>;

/**
 * Seletores a tentar pra um alvo, em ordem. Parte: o medido na página do teste
 * primeiro, o da captura depois. A captura pode ser de uma versão anterior da
 * página ou ter vindo nula por bug.
 */
export function selectorCandidates(
  target: VerifyTarget,
  capture: PageCapture,
  fresh: FreshSelectors,
): string[] {
  const fromCapture = selectorFor(target, capture);
  const fromPage = target.kind === "part" ? fresh[target.part] : null;
  return [...new Set([fromPage, fromCapture].filter((s): s is string => !!s))];
}

/** As partes que os passos do teste miram (sem repetir). */
export function partsOf(check: VerifyCheck): PartKey[] {
  const out = new Set<PartKey>();
  for (const step of check.steps) {
    if ("target" in step && step.target.kind === "part") {
      out.add(step.target.part);
    }
  }
  return [...out];
}

/** Nome do alvo pro relato: o rótulo da captura, ou o nome da parte. */
function targetName(target: VerifyTarget, capture: PageCapture): string {
  if (target.kind === "part") return PART_NAMES[target.part];
  return (
    capture.element_labels?.[target.key]?.label ?? `elemento ${target.key}`
  );
}

function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

/**
 * O que um clique mudou. URL diferente (fora o #) é navegação: o teste para
 * ali, porque os passos seguintes rodariam numa página estranha.
 */
export function describeClickChange(
  before: ClickSnapshot,
  after: ClickSnapshot,
): { changed: boolean; navigated: boolean; text: string } {
  if (withoutHash(before.url) !== withoutHash(after.url)) {
    return {
      changed: true,
      navigated: true,
      text: `navegou de ${before.url} para ${after.url}`,
    };
  }
  const changes: string[] = [];
  if (before.url !== after.url)
    changes.push(`a URL ganhou âncora (${after.url})`);
  if (after.openDialogs > before.openDialogs) {
    changes.push(
      `abriu diálogo (${before.openDialogs} → ${after.openDialogs})`,
    );
  } else if (after.openDialogs < before.openDialogs) {
    changes.push(
      `fechou diálogo (${before.openDialogs} → ${after.openDialogs})`,
    );
  }
  if (after.selection !== before.selection) {
    changes.push(
      after.selection
        ? `seleção de texto: "${after.selection.slice(0, 80)}"`
        : "seleção de texto sumiu",
    );
  }
  if (after.activeTag !== before.activeTag) {
    changes.push(`foco foi pra <${after.activeTag ?? "nada"}>`);
  }
  if (after.nearHtmlHash !== before.nearHtmlHash) {
    changes.push("o HTML em volta do alvo mudou");
  }
  if (changes.length === 0) {
    return {
      changed: false,
      navigated: false,
      text: "nada mudou: mesma URL, sem diálogo, sem seleção de texto, HTML em volta igual",
    };
  }
  return { changed: true, navigated: false, text: changes.join("; ") };
}

/**
 * "o alvo é um invólucro 390×0; medi o filho visível div.fixed… 390×844" quando
 * a medida veio do filho (ver `ElementFacts.wrapper`); "" se não.
 */
function wrapperNote(f: ElementFacts): string {
  if (!f.wrapper) return "";
  const size = f.rect ? ` ${f.rect.width}×${f.rect.height}` : "";
  return `o alvo é um invólucro ${f.wrapper.width}×${f.wrapper.height}; medi o filho visível ${f.wrapper.child}${size}`;
}

/** "h1 "Relógio...": cursor pointer, cor #1a0dab vs pai #222222, ..." */
export function describeFacts(f: ElementFacts): string {
  const parts = [
    `cursor ${f.cursor}`,
    `cor ${f.color} vs pai ${f.parentColor}`,
    f.textDecoration.includes("underline") ? "sublinhado" : "sem sublinhado",
    f.inLink ? `dentro de <a href=${f.href ?? ""}>` : "fora de <a>",
  ];
  if (f.inButton) parts.push("dentro de botão");
  if (f.role) parts.push(`role=${f.role}`);
  parts.push(
    f.hasClickHandler
      ? "parece ter clique (onclick ou cursor pointer)"
      : "sem sinal de clique",
  );
  if (f.rect) {
    parts.push(`${f.rect.width}×${f.rect.height} em y=${f.rect.y}`);
  }
  const note = wrapperNote(f);
  if (note) parts.push(note);
  // Rótulo visível quando há (tooltip escondido fora).
  const shown = f.label || f.text;
  const text = shown ? ` "${shown.slice(0, 40)}"` : "";
  return `<${f.tag}>${text}: ${parts.join(", ")}`;
}

/**
 * Recorte do print em volta do elemento: largura da tela, pelo menos 40% da
 * altura dela de contexto, nunca mais que uma tela (coordenadas do documento).
 */
export function clipAround(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const pad = 24;
  const height = Math.round(
    Math.min(
      viewport.height,
      Math.max(rect.height + pad * 2, viewport.height * 0.4),
    ),
  );
  const y =
    rect.height + pad * 2 > viewport.height
      ? rect.y - pad
      : rect.y + rect.height / 2 - height / 2;
  return {
    x: 0,
    y: Math.max(0, Math.round(y)),
    width: viewport.width,
    height,
  };
}

/**
 * Junta o relato dos passos, cortado no teto. Corta o MEIO: a última linha é o
 * motivo de o teste ter parado, e o juiz precisa dela.
 */
export function capObserved(lines: string[], max = MAX_OBSERVED_CHARS): string {
  const all = lines.join("\n");
  if (all.length <= max) return all;
  if (lines.length < 2) return `${all.slice(0, max - 1)}…`;
  const sep = "\n…\n";
  const last = (lines[lines.length - 1] ?? "").slice(0, Math.floor(max / 2));
  const head = lines
    .slice(0, -1)
    .join("\n")
    .slice(0, max - last.length - sep.length);
  return `${head}${sep}${last}`;
}

/**
 * O caminho do gesto, em fração da tela: o miolo, longe do cabeçalho (menu que
 * abre no hover) e da barra de compra fixa embaixo.
 */
export const GESTURE_PATH: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.4],
  [0.3, 0.5],
  [0.7, 0.55],
  [0.5, 0.6],
];

/**
 * O pedaço da página que o gesto usa: só mover o mouse. Nada de clique nem
 * toque aqui, nunca.
 */
interface GesturePage {
  mouseMove(x: number, y: number, steps: number): Promise<void>;
}

/**
 * Mexe o mouse por alguns pontos do miolo da tela. Há pop-up de newsletter que
 * só abre no primeiro mousemove/touchmove. Só o mouse: um toque sem início e
 * fim vira dedo pressionado que nunca solta (arrasta galeria, dispara handler).
 */
export async function performGesture(
  p: GesturePage,
  viewport: { width: number; height: number },
): Promise<void> {
  for (const [fx, fy] of GESTURE_PATH) {
    await p.mouseMove(
      Math.round(viewport.width * fx),
      Math.round(viewport.height * fy),
      5,
    );
  }
}

/** Espera curta depois de um clique: navegação ou reação da página. */
const CLICK_SETTLE_MS = 1500;
const RELOAD_TIMEOUT_MS = 45_000;
const HIT_SELECTOR = "[data-ux-hit]";
const CHOICE_SELECTOR = "[data-ux-choice]";

/** O teste não pode seguir; o motivo vai pro relato. */
class StopCheck extends Error {
  constructor(
    readonly outcome: "nao_testou" | "nao_decidiu",
    message: string,
  ) {
    super(message);
  }
}

type ClickResult =
  | { kind: "new_tab"; href: string | null; target: string | null }
  | { kind: "clicked"; to: string | null; before: ClickSnapshot | null };

/** O que `runLiveCheck` usa de fora; os testes trocam por uma página falsa. */
interface LiveIo {
  openPage: (
    browser: BrowserPort,
    url: string,
    device: UxDevice,
    opts: {
      blockRequest?: (url: string) => boolean;
      keepOverlays?: boolean;
    },
  ) => Promise<BrowserPage>;
  screenshotClip: typeof screenshotClip;
  storeImage: typeof storeImage;
  sleep: (ms: number) => Promise<void>;
}

const REAL_IO: LiveIo = { openPage, screenshotClip, storeImage, sleep };

/**
 * Roda um teste "live" na PDP da captura. Sempre devolve um CheckRun (nunca
 * lança): qualquer falha vira `nao_testou` com o motivo, sem derrubar os
 * outros testes da hipótese.
 */
export async function runLiveCheck(opts: {
  browser: BrowserPort;
  capture: PageCapture;
  check: VerifyCheck;
  elementKeys: string[];
  media: MediaStore;
  keyPrefix: string;
  io?: Partial<LiveIo>;
}): Promise<CheckRun> {
  const { browser, capture, check, elementKeys, media, keyPrefix } = opts;
  const io: LiveIo = { ...REAL_IO, ...opts.io };
  const log: string[] = [];
  let shot: string | null = null;
  let page: BrowserPage | null = null;
  // Rastreio abortado nas páginas já fechadas; null = nenhuma página abriu.
  let blockedBefore: number | null = null;
  const blocked = () =>
    blockedBefore === null
      ? null
      : blockedBefore + (page?.blockedRequests() ?? 0);

  const anchor = async (p: BrowserPage) => {
    if (elementKeys.length === 0) return;
    try {
      await p.evaluate(elementLabelsInPage, elementKeys);
    } catch (err) {
      // Sem âncora, todo alvo de elemento vira "não achei"; o relato diz por quê.
      log.push(
        `não consegui marcar os elementos da Deco Analytics: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  // As partes que o teste mira são medidas de novo a cada open e reload; o seletor da captura vira reserva.
  const parts = partsOf(check);
  let fresh: FreshSelectors = {};
  const noted = new Set<PartKey>();
  const remeasure = async (p: BrowserPage) => {
    if (parts.length === 0) return;
    try {
      // Sem rolar: rolar dispara pop-up de scroll e lazy-load, mudando o que o teste observa.
      const kind = capture.page_type;
      const m: {
        positions: Partial<Record<UxPart, number | null>>;
        selectors: Partial<Record<UxPart, string | null>>;
      } | null =
        kind && kind !== "pdp" && kind !== "carrinho_checkout"
          ? await p.evaluate(measureSitePageInPage, kind, { skipScroll: true })
          : await p.evaluate(measurePdpInPage, { skipScroll: true });
      fresh = m?.selectors ?? {};
      for (const part of parts) {
        if (!fresh[part] || capture.selectors?.[part] || noted.has(part))
          continue;
        noted.add(part);
        log.push(
          `${PART_NAMES[part]}: a captura não tinha, achei nesta página em y=${m?.positions[part] ?? "?"}`,
        );
      }
    } catch (err) {
      fresh = {};
      log.push(
        `não consegui medir as partes nesta página (${err instanceof Error ? err.message : String(err)}); vale o seletor da captura`,
      );
    }
  };
  const open = async (keepOverlays = false): Promise<BrowserPage> => {
    const previous = page;
    if (previous) {
      await previous.close().catch(() => {});
      blockedBefore = (blockedBefore ?? 0) + previous.blockedRequests();
    }
    page = null;
    blockedBefore ??= 0;
    const p = await io.openPage(browser, capture.url, check.device, {
      blockRequest: isTrackingRequest,
      keepOverlays,
    });
    page = p;
    await anchor(p);
    await remeasure(p);
    return p;
  };
  const resolve = async (p: BrowserPage, target: VerifyTarget) => {
    const name = targetName(target, capture);
    for (const selector of selectorCandidates(target, capture, fresh)) {
      const facts = await p.evaluate(elementFactsInPage, selector);
      if (facts?.found) return { selector, facts, name };
    }
    throw new StopCheck(
      "nao_testou",
      `não achei o alvo (${name}) nesta página`,
    );
  };
  const assertClickable = (facts: ElementFacts) => {
    const reason = forbiddenReason(facts);
    if (reason) {
      throw new StopCheck(
        "nao_testou",
        `clicar aqui mexeria na loja (${reason})`,
      );
    }
  };
  /**
   * O único caminho de clique. O mouse clica num PONTO, e no ponto pode estar
   * outra coisa (barra de compra fixa): então o que vale é quem está por cima
   * ali, e esse também passa pela trava de proibido. A ordem importa:
   * rola e espera a página reagir (outro evaluate), testa o ponto, tira o
   * "antes" (observe_click) e clica na hora — nada mexe na página entre o
   * "antes" e o clique.
   *
   * Link que abre outra aba (`_blank`, um nome de janela, ou o `<base
   * target>` do documento) não é clicado: a aba nova nasce sem o bloqueio de
   * rastreio (a interceptação é por página) e a atual não muda.
   */
  const clickSafely = async (
    p: BrowserPage,
    selector: string,
    facts: ElementFacts,
    name: string,
    snapshot: boolean,
  ): Promise<ClickResult> => {
    assertClickable(facts);
    // Alvo escondido (0×0): o centro de um retângulo vazio é (0,0), e ali fica outra coisa.
    if (isHiddenTarget(facts)) {
      throw new StopCheck(
        "nao_testou",
        `o alvo (${name}) não aparece nesta página: mede ${Math.round(facts.rect?.width ?? 0)}×${Math.round(facts.rect?.height ?? 0)} (escondido nesta tela)`,
      );
    }
    const scrolled = await p.evaluate(scrollToCenterInPage, selector);
    const point = scrolled
      ? await p.evaluate(clickPointInPage, selector)
      : { found: false, covered: false, x: 0, y: 0 };
    if (!point.found) {
      throw new StopCheck(
        "nao_testou",
        `não achei o alvo (${name}) nesta página`,
      );
    }
    const hit = await p.evaluate(elementFactsInPage, HIT_SELECTOR);
    if (point.covered) {
      const what = hit.found
        ? `<${hit.tag}>${hit.text ? ` "${hit.text.slice(0, 40)}"` : ""}`
        : "nada clicável";
      throw new StopCheck(
        "nao_testou",
        `outro elemento cobre o alvo (${name}) no ponto do clique: ${what}`,
      );
    }
    if (hit.found) assertClickable(hit);
    const blank = [facts, hit].find(
      (f) => f.found && f.inLink && opensNewTab(f.linkTarget),
    );
    if (blank)
      return { kind: "new_tab", href: blank.href, target: blank.linkTarget };
    const before = snapshot
      ? await p.evaluate(clickSnapshotInPage, selector)
      : null;
    const beforeUrl = p.url();
    // Navegação pedida na janela do clique conta, mesmo se a URL ainda não trocou.
    const { navigation } = await p.click(point.x, point.y, CLICK_SETTLE_MS);
    const to =
      navigation ??
      (withoutHash(p.url()) !== withoutHash(beforeUrl) ? p.url() : null);
    return { kind: "clicked", to, before };
  };
  const newTabText = (t: { href: string | null; target: string | null }) =>
    `o link abre em outra aba (target=${t.target ?? ""}${t.href ? `, href=${t.href}` : ""}); não cliquei, a aba nova ficaria sem o bloqueio de rastreio e esta página não muda`;
  const navigatedStop = (what: string, to: string) =>
    new StopCheck(
      "nao_decidiu",
      `${what} navegou pra ${to}; o teste termina aqui`,
    );

  try {
    for (const step of check.steps) {
      if (step.op === "open") {
        const keep = step.keep_overlays === true;
        const p = await open(keep);
        log.push(
          `open: ${p.url()}${keep ? " (com pop-ups e banners abertos)" : ""}`,
        );
        continue;
      }
      // O plano sempre começa com open (validateSteps); por via das dúvidas.
      const p: BrowserPage = page ?? (await open());
      switch (step.op) {
        case "reload": {
          await p.reload(RELOAD_TIMEOUT_MS).catch(() => {});
          const keep = step.keep_overlays === true;
          if (!keep) await p.evaluate(dismissOverlaysInPage).catch(() => {});
          await anchor(p);
          await remeasure(p);
          log.push(
            `reload: recarreguei a página${keep ? " (com pop-ups e banners abertos)" : ""}`,
          );
          break;
        }
        case "gesture": {
          // Sem clique e sem toque: só o mouse.
          await performGesture(p, p.viewport);
          log.push("gesture: mexi o mouse na página");
          break;
        }
        case "wait": {
          const ms = Math.max(0, Math.min(step.ms, MAX_WAIT_MS));
          await io.sleep(ms);
          log.push(`wait: ${ms} ms`);
          break;
        }
        case "choose_size":
        case "choose_variant": {
          const kind: "size" | "variant" =
            step.op === "choose_size" ? "size" : "variant";
          const what = kind === "size" ? "tamanho" : "variação";
          const picked = await p.evaluate(chooseOptionInPage, kind);
          const facts = picked
            ? await p.evaluate(elementFactsInPage, CHOICE_SELECTOR)
            : null;
          if (!picked || !facts?.found) {
            throw new StopCheck(
              "nao_testou",
              `não achei opção de ${what} disponível pra escolher`,
            );
          }
          const res = await clickSafely(
            p,
            CHOICE_SELECTOR,
            facts,
            `opção de ${what} "${picked}"`,
            false,
          );
          if (res.kind === "new_tab") {
            throw new StopCheck(
              "nao_testou",
              `a opção de ${what} "${picked}" ${newTabText(res).replace("o link ", "")}`,
            );
          }
          log.push(`${step.op}: escolhi ${what} "${picked}"`);
          if (res.to) throw navigatedStop(`escolher ${what}`, res.to);
          await io.sleep(CLICK_SETTLE_MS);
          break;
        }
        case "scroll_to": {
          const { selector, name } = await resolve(p, step.target);
          // Rolagem instantânea + espera da página: a lisa ainda andava quando o teste lia a página.
          const moved = await p.evaluate(scrollToCenterInPage, selector);
          if (!moved) {
            throw new StopCheck(
              "nao_testou",
              `não consegui rolar até ${name} nesta página`,
            );
          }
          const after = await p.evaluate(elementFactsInPage, selector);
          log.push(
            `scroll_to ${name}: rolei até ele (y=${after.rect?.y ?? "?"})`,
          );
          break;
        }
        case "inspect": {
          const { facts, name } = await resolve(p, step.target);
          log.push(`inspect ${name}: ${describeFacts(facts)}`);
          break;
        }
        case "click": {
          const { selector, facts, name } = await resolve(p, step.target);
          const res = await clickSafely(p, selector, facts, name, false);
          if (res.kind === "new_tab") {
            log.push(`click ${name}: ${newTabText(res)}`);
            break;
          }
          log.push(`click ${name}: cliquei`);
          if (res.to) throw navigatedStop("o clique", res.to);
          break;
        }
        case "observe_click": {
          const { selector, facts, name } = await resolve(p, step.target);
          // Só o relato: o clique segue no alvo, com a trava de sempre.
          const note = wrapperNote(facts);
          const label = `observe_click ${name}${facts.href ? ` (href=${facts.href})` : ""}${note ? ` (${note})` : ""}`;
          const res = await clickSafely(p, selector, facts, name, true);
          if (res.kind === "new_tab") {
            log.push(`${label}: ${newTabText(res)}`);
            break;
          }
          const before =
            res.before ?? (await p.evaluate(clickSnapshotInPage, selector));
          // A navegação vai na mensagem de parada: a última linha, que capObserved nunca corta.
          if (res.to) {
            throw new StopCheck(
              "nao_decidiu",
              `${label}: navegou de ${before.url} para ${res.to}; o teste termina aqui`,
            );
          }
          const after = await snapshotAfterClick(p, selector, io.sleep);
          const change = describeClickChange(before, after);
          if (change.navigated) {
            throw new StopCheck(
              "nao_decidiu",
              `${label}: ${change.text}; o teste termina aqui`,
            );
          }
          log.push(`${label}: ${change.text}`);
          break;
        }
        case "screenshot": {
          const { facts, name } = await resolve(p, step.target);
          if (!facts.rect || facts.rect.width < 1 || facts.rect.height < 1) {
            throw new StopCheck(
              "nao_testou",
              `o alvo (${name}) está na página mas não aparece (tamanho zero)`,
            );
          }
          const bytes = await io.screenshotClip(
            p,
            clipAround(facts.rect, p.viewport),
          );
          shot = await io.storeImage(
            media,
            `${keyPrefix}-${check.id}.jpg`,
            bytes,
          );
          const note = wrapperNote(facts);
          log.push(
            `screenshot ${name}: salvei o print${note ? ` (${note})` : ""}`,
          );
          break;
        }
      }
    }
    return run(check, "nao_decidiu", withBlocked(log, blocked()), shot);
  } catch (err) {
    if (err instanceof StopCheck) {
      log.push(err.message);
      return run(check, err.outcome, withBlocked(log, blocked()), shot);
    }
    log.push(
      `o passo quebrou: ${err instanceof Error ? err.message : String(err)}`,
    );
    return run(check, "nao_testou", withBlocked(log, blocked()), shot);
  } finally {
    const p = page as BrowserPage | null;
    if (p) await p.close().catch(() => {});
  }
}

/**
 * O bloqueio de rastreio no relato: na PRIMEIRA linha, o começo que
 * `capObserved` guarda (o meio é que é cortado).
 */
function withBlocked(log: string[], blocked: number | null): string[] {
  return blocked === null
    ? log
    : [`bloqueei ${blocked} pedidos de rastreio`, ...log];
}

function run(
  check: VerifyCheck,
  outcome: CheckRun["outcome"],
  log: string[],
  shot: string | null,
): CheckRun {
  return {
    check,
    outcome,
    observed: capObserved(log),
    screenshot_url: shot,
    source_ref: null,
  };
}

/**
 * Snapshot depois do clique. Se a página navegou no meio, o evaluate morre com
 * "Execution context was destroyed": tenta de novo e, se ainda falhar, fica só
 * com a URL (que é o que importa pra saber se navegou).
 */
async function snapshotAfterClick(
  p: BrowserPage,
  selector: string,
  wait: (ms: number) => Promise<void>,
): Promise<ClickSnapshot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await p.evaluate(clickSnapshotInPage, selector);
    } catch {
      await wait(500);
    }
  }
  return {
    url: p.url(),
    activeTag: null,
    selection: "",
    nearHtmlHash: "",
    openDialogs: 0,
  };
}
