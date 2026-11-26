/**
 * The verifier's live stage: runs a check's steps on the real page and reports
 * what it saw (`nao_decidiu`) or why it could not (`nao_testou`); the judge
 * decides. Tracking is blocked and nothing that changes the store is clicked.
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

/** Cap on the report, which goes whole into the judge's prompt. */
const MAX_OBSERVED_CHARS = 1200;

type PartKey = UxPart;

const PART_NAMES: Record<PartKey, string> = {
  ...PART_WORD,
  first_recommendation: "primeira recomendação",
};

/** The target has no visible area on this screen (hidden, or a wrapper with no visible child). */
export function isHiddenTarget(facts: ElementFacts): boolean {
  const r = facts.rect;
  return !r || r.width < 2 || r.height < 2;
}

/**
 * The target's selector on the open page: an analytics element's anchor from
 * `elementLabelsInPage`, or the part's selector from the capture (null if none).
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

/** Selectors measured on the check's page (`measurePdpInPage`), by part. */
type FreshSelectors = Partial<Record<PartKey, string | null>>;

/**
 * Selectors to try for a target, in order. For a part, the one measured on the
 * check's page first: the capture may be stale or missing it.
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

/** The distinct parts the check's steps target. */
export function partsOf(check: VerifyCheck): PartKey[] {
  const out = new Set<PartKey>();
  for (const step of check.steps) {
    if ("target" in step && step.target.kind === "part") {
      out.add(step.target.part);
    }
  }
  return [...out];
}

/** The target's name for the report: the capture's label, or the part's name. */
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
 * What a click changed. A different URL (ignoring #) is a navigation: the check
 * stops there, since later steps would run on another page.
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

/** A note when the measurement came from a visible child (`ElementFacts.wrapper`); "" otherwise. */
function wrapperNote(f: ElementFacts): string {
  if (!f.wrapper) return "";
  const size = f.rect ? ` ${f.rect.width}×${f.rect.height}` : "";
  return `o alvo é um invólucro ${f.wrapper.width}×${f.wrapper.height}; medi o filho visível ${f.wrapper.child}${size}`;
}

/** One line of the element's facts: tag, text, cursor, colors, link, size. */
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
  // The visible label when there is one (a hidden tooltip stays out).
  const shown = f.label || f.text;
  const text = shown ? ` "${shown.slice(0, 40)}"` : "";
  return `<${f.tag}>${text}: ${parts.join(", ")}`;
}

/**
 * Screenshot clip around the element, in document coordinates: full width, at
 * least 40% of the viewport height of context, never more than one screen.
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
 * Joins the step report, capped. Cuts the middle: the last line says why the
 * check stopped, and the judge needs it.
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
 * The gesture's path, as viewport fractions: the middle, away from the header
 * (hover menus) and the sticky buy bar at the bottom.
 */
export const GESTURE_PATH: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.4],
  [0.3, 0.5],
  [0.7, 0.55],
  [0.5, 0.6],
];

/** What the gesture uses of the page: mouse moves only, never a click or touch. */
interface GesturePage {
  mouseMove(x: number, y: number, steps: number): Promise<void>;
}

/**
 * Moves the mouse through the middle of the screen, since some pop-ups open on
 * the first mousemove. Mouse only: an unfinished touch stays pressed forever.
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

/** Short wait after a click, for a navigation or the page's reaction. */
const CLICK_SETTLE_MS = 1500;
const RELOAD_TIMEOUT_MS = 45_000;
const HIT_SELECTOR = "[data-ux-hit]";
const CHOICE_SELECTOR = "[data-ux-choice]";

/** The check cannot go on; the reason goes into the report. */
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

/** What `runLiveCheck` uses from outside; tests swap in a fake page. */
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
 * Runs a live check on the capture's page. Never throws: any failure becomes
 * `nao_testou` with the reason, leaving the hypothesis' other checks alone.
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
  // Tracking blocked on pages already closed; null = no page opened.
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
      // Without anchors every element target is "not found"; the report says why.
      log.push(
        `não consegui marcar os elementos da Deco Analytics: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  // Targeted parts are remeasured on every open and reload; the capture's selector is the fallback.
  const parts = partsOf(check);
  let fresh: FreshSelectors = {};
  const noted = new Set<PartKey>();
  const remeasure = async (p: BrowserPage) => {
    if (parts.length === 0) return;
    try {
      // No scrolling: it triggers scroll pop-ups and lazy loading, changing what the check sees.
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
   * The only click path: whatever sits on top at the click point must also pass
   * the forbidden check, and links opening another tab (no tracking block) are not clicked.
   */
  const clickSafely = async (
    p: BrowserPage,
    selector: string,
    facts: ElementFacts,
    name: string,
    snapshot: boolean,
  ): Promise<ClickResult> => {
    assertClickable(facts);
    // A 0×0 target's center is (0,0), where something else sits.
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
    // A navigation requested during the click counts even before the URL changes.
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
      // Plans always start with open (validateSteps); this is a safeguard.
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
          // No click and no touch: mouse only.
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
          // Instant scroll plus a settle wait: smooth scrolling was still moving when the check read the page.
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
          // Report only: the click still goes to the target, with the usual guard.
          const note = wrapperNote(facts);
          const label = `observe_click ${name}${facts.href ? ` (href=${facts.href})` : ""}${note ? ` (${note})` : ""}`;
          const res = await clickSafely(p, selector, facts, name, true);
          if (res.kind === "new_tab") {
            log.push(`${label}: ${newTabText(res)}`);
            break;
          }
          const before =
            res.before ?? (await p.evaluate(clickSnapshotInPage, selector));
          // The navigation goes in the stop message, the last line, which capObserved never cuts.
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

/** Puts the tracking-block count on the first line, which `capObserved` keeps. */
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
 * Snapshot after the click. If the page navigated, evaluate fails with "Execution
 * context was destroyed": retry once, then keep only the URL.
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
