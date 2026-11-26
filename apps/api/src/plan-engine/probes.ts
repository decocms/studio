/**
 * Probes: what the page DOES, measured before any hypothesis (reproduce before
 * asserting). Two code-only probes: **layers** (fixed overlays over the first
 * screen and whether they cover price and buy button) and **touch** (click
 * elements with many dead clicks and report what changed). Failures become
 * results with the reason, never errors.
 */

import { describeElementLabel } from "./hypotheses.ts";
import type { OverlaysReading } from "./page-scripts.ts";
import type { DiagnosisEvidence, PageCapture, UxDevice } from "./types.ts";

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
