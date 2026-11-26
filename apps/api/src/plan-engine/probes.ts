/**
 * Probes: what the page DOES, measured before any hypothesis (reproduce before
 * asserting). Two code-only probes: **layers** (fixed overlays over the first
 * screen and whether they cover price and buy button) and **touch** (click
 * elements with many dead clicks and report what changed). Failures become
 * results with the reason, never errors.
 */

import { sleep } from "@decocms/shared/std";
import { openPage, screenshotClip, storeImage } from "./browser.ts";
import { describeElementLabel } from "./hypotheses.ts";
import { type OverlaysReading, overlaysInPage } from "./page-scripts.ts";
import type { BrowserPort, MediaStore } from "./ports.ts";
import type { DiagnosisEvidence, PageCapture, UxDevice } from "./types.ts";
import { performGesture, runLiveCheck } from "./verify/live.ts";
import { isTrackingRequest } from "./verify/safety.ts";

export type ProbeResult =
  | {
      kind: "camadas";
      device: UxDevice;
      url: string;
      ok: true;
      reading: OverlaysReading;
      /** First-screen screenshot with the layers open. */
      screenshot_url: string | null;
    }
  | {
      kind: "toque";
      device: UxDevice;
      url: string;
      ok: true;
      /** `root|el` from Deco Analytics. */
      key: string;
      label: string;
      /** What changed after the click, or why it did not click. */
      observed: string;
      /** false = did not click (forbidden, hidden, covered, not found). */
      clicked: boolean;
    }
  | {
      kind: "camadas" | "toque";
      device: UxDevice;
      url: string;
      ok: false;
      error: string;
      key?: string;
      label?: string;
    };

/** Elements touched per device (each reopens the page). */
const MAX_TOUCH_PROBES = 2;
/** From this much dead click on a clickable element, it is worth touching. */
const DEAD_SHARE = 0.3;
const MIN_CLICKS = 200;
/** O pop-up que abre com atraso (uma loja, 14/11: >3 s). */
const OVERLAY_WAIT_MS = 5_000;

/** Each screen's capture of the usual page (not the missing state). */
export function primaryCaptures(evidence: DiagnosisEvidence): PageCapture[] {
  const out: PageCapture[] = [];
  for (const device of ["mobile", "desktop"] as const) {
    const c =
      evidence.captures.find(
        (x) =>
          x.device === device &&
          x.stock !== "sold_out" &&
          x.stock !== "broken_grid",
      ) ?? evidence.captures.find((x) => x.device === device);
    if (c?.viewport) out.push(c);
  }
  return out;
}

/** Elements to touch on a screen: clickable, many dead clicks, not navigating or hidden. Exported for tests. */
export function touchTargets(
  evidence: DiagnosisEvidence,
  capture: PageCapture,
): Array<{ key: string; label: string }> {
  const b = evidence.pdp_behaviour.find((x) => x.device === capture.device);
  const labels = capture.element_labels ?? {};
  return (b?.elements ?? [])
    .filter(
      (e) =>
        e.clicks >= MIN_CLICKS && e.dead_interactive / e.clicks >= DEAD_SHARE,
    )
    .map((e) => ({
      e,
      key: `${e.root}|${e.el}`,
      l: labels[`${e.root}|${e.el}`],
    }))
    .filter(({ l }) => l && !l.navigates && !l.hidden)
    .sort((a, b) => b.e.dead_interactive - a.e.dead_interactive)
    .slice(0, MAX_TOUCH_PROBES)
    .map(({ key, l }) => ({ key, label: l ? describeElementLabel(l) : key }));
}

/** Seletores das partes medidas na captura, pra sonda de camadas. */
function partSelectors(capture: PageCapture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [part, selector] of Object.entries(capture.selectors ?? {})) {
    if (selector) out[part] = selector;
  }
  return out;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Abre sem fechar nada, mexe o mouse, espera o pop-up e mede. */
async function probeOverlays(opts: {
  browser: BrowserPort;
  capture: PageCapture;
  media: MediaStore | null;
  keyPrefix: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<ProbeResult> {
  const { capture } = opts;
  const base = {
    kind: "camadas" as const,
    device: capture.device,
    url: capture.url,
  };
  const page = await openPage(opts.browser, capture.url, capture.device, {
    blockRequest: isTrackingRequest,
    keepOverlays: true,
  }).catch((err: unknown) => message(err));
  if (typeof page === "string") return { ...base, ok: false, error: page };
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await performGesture(page, capture.viewport);
    await opts.sleep(OVERLAY_WAIT_MS);
    const reading = await page.evaluate(overlaysInPage, partSelectors(capture));
    let shot: string | null = null;
    if (opts.media) {
      const bytes = await screenshotClip(page, {
        x: 0,
        y: 0,
        width: capture.viewport.width,
        height: capture.viewport.height,
      }).catch(() => null);
      if (bytes) {
        shot = await storeImage(
          opts.media,
          `${opts.keyPrefix}/camadas-${capture.device}.jpg`,
          bytes,
        ).catch(() => null);
      }
    }
    return { ...base, ok: true, reading, screenshot_url: shot };
  } catch (err) {
    return { ...base, ok: false, error: message(err) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Toca num elemento pelo caminho do verificador e diz o que mudou. */
async function probeTouch(opts: {
  browser: BrowserPort;
  capture: PageCapture;
  target: { key: string; label: string };
  elementKeys: string[];
  media: MediaStore | null;
  keyPrefix: string;
}): Promise<ProbeResult> {
  const { capture, target } = opts;
  const base = {
    kind: "toque" as const,
    device: capture.device,
    url: capture.url,
    key: target.key,
    label: target.label,
  };
  if (!opts.media) {
    return { ...base, ok: false, error: "sem onde guardar o print" };
  }
  try {
    const run = await runLiveCheck({
      browser: opts.browser,
      capture,
      check: {
        id: `sonda-${capture.device}-${target.key.replace(/\W/g, "")}`,
        claim: `o que acontece ao tocar em ${target.label}`,
        stage: "live",
        device: capture.device,
        steps: [
          { op: "open" },
          { op: "observe_click", target: { kind: "element", key: target.key } },
        ],
        question: null,
        confirms_if: "",
        refutes_if: "",
      },
      elementKeys: opts.elementKeys,
      media: opts.media,
      keyPrefix: `${opts.keyPrefix}/toque`,
    });
    return {
      ...base,
      ok: true,
      observed: run.observed,
      clicked: run.outcome !== "nao_testou",
    };
  } catch (err) {
    return { ...base, ok: false, error: message(err) };
  }
}

/**
 * Roda as sondas nas capturas de cada tela, uma de cada vez (o navegador é
 * dividido com as outras páginas). Passou do prazo, para e diz quais ficaram
 * de fora.
 */
export async function runProbes(opts: {
  browser: BrowserPort;
  evidence: DiagnosisEvidence;
  media: MediaStore | null;
  keyPrefix: string;
  /** Até quando uma sonda pode começar (ms epoch). */
  deadline: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const wait = opts.sleep ?? sleep;
  const elementKeys = (opts.evidence.pdp_behaviour ?? []).flatMap((b) =>
    (b.elements ?? []).map((e) => `${e.root}|${e.el}`),
  );
  for (const capture of primaryCaptures(opts.evidence)) {
    const late = () => Date.now() > opts.deadline;
    if (late()) break;
    out.push(
      await probeOverlays({
        browser: opts.browser,
        capture,
        media: opts.media,
        keyPrefix: opts.keyPrefix,
        sleep: wait,
      }),
    );
    for (const target of touchTargets(opts.evidence, capture)) {
      if (late()) break;
      out.push(
        await probeTouch({
          browser: opts.browser,
          capture,
          target,
          elementKeys,
          media: opts.media,
          keyPrefix: opts.keyPrefix,
        }),
      );
    }
  }
  return out;
}
