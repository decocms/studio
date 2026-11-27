/**
 * Hypothesis verifier contract: the model only assembles steps from the fixed
 * list below and points at our targets, never writing browser code or free selectors.
 */

import type { UxPart } from "../types.ts";

export type VerifyTarget =
  | { kind: "element"; key: string } // "root|el" from Deco Analytics
  | {
      kind: "part";
      /** A measured part of the analyzed page type (page-types.ts). */
      part: UxPart;
    };

export type VerifyStep =
  /** `keep_overlays`: open (or reload) without closing pop-ups/modals/banners, so overlay hypotheses measure the open overlay. */
  | { op: "open"; keep_overlays?: boolean }
  | { op: "reload"; keep_overlays?: boolean }
  | { op: "choose_size" }
  | { op: "choose_variant" }
  /** Moves the mouse over the screen center without clicking; some pop-ups only open on the first mousemove/touchmove. */
  | { op: "gesture" }
  | { op: "wait"; ms: number }
  | {
      op: "click" | "scroll_to" | "inspect" | "observe_click" | "screenshot";
      target: VerifyTarget;
    };

export interface VerifyCheck {
  /** "c1".."c4"; "c1-f" is the test the repo asked of the browser. */
  id: string;
  claim: string;
  /** "data": checked only against the diagnosis data (data-checks.ts). */
  stage: "live" | "repo" | "data";
  device: "mobile" | "desktop";
  /** Empty on "repo". */
  steps: VerifyStep[];
  /** "repo" only. */
  question: string | null;
  confirms_if: string;
  refutes_if: string;
}

export type CheckOutcome =
  | "confirma"
  | "desmente"
  | "nao_decidiu"
  | "nao_testou";

export interface CheckRun {
  check: VerifyCheck;
  outcome: CheckOutcome;
  /** What was seen, in Portuguese, with numbers/styles. */
  observed: string;
  screenshot_url: string | null;
  /** "src/sections/Product/ProductDetails.tsx:88" on repo. */
  source_ref: string | null;
  /** false = the judge said this test does not measure the cause (it measures the symptom): it counts for neither the verdict nor the validation levels. Absent = counts. */
  measures_cause?: boolean;
}

export type Verdict =
  | "confirmada"
  | "desmentida"
  | "reescrita"
  | "inconclusiva";

export interface HypothesisVerification {
  verdict: Verdict;
  /** One line, cites the deciding test. */
  summary: string;
  runs: CheckRun[];
  rewritten_from: { title: string; why: string } | null;
  verified_at: string;
  /** Confidence before any verification; "verify again" starts from it so each confirmation does not add the bonus twice. */
  base_confidence?: number;
  /** Refuted: the investigation lines the proof opens. Absent = none. */
  novas_linhas?: string[];
  /** Confirmed: whether independent checks agree (`confirmationStrength`). Absent = not confirmed, or older. */
  strength?: ConfirmationStrength;
}

/**
 * "corroborada": confirming checks from at least two independent vantage
 * points (the code, and the live page or the data on a given screen).
 * "isolada": one vantage point, so one model reading decided it.
 */
export type ConfirmationStrength = "corroborada" | "isolada";

export const MAX_CHECKS = 4;
export const MAX_STEPS = 8;
/** Ceiling of a `wait` step; some newsletter pop-ups open late and still measure 0×0 after 3 s. */
export const MAX_WAIT_MS = 8000;

const VERDICTS: readonly string[] = [
  "confirmada",
  "desmentida",
  "reescrita",
  "inconclusiva",
];

export function encodeVerification(
  v: HypothesisVerification | null,
): string | null {
  return v ? JSON.stringify(v) : null;
}

/** Invalid or malformed JSON becomes null: the hypothesis stays without a seal. */
export function decodeVerification(
  raw: unknown,
): HypothesisVerification | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HypothesisVerification> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.verdict !== "string" ||
      !VERDICTS.includes(parsed.verdict) ||
      !Array.isArray(parsed.runs)
    ) {
      return null;
    }
    const { base_confidence, strength, ...rest } =
      parsed as HypothesisVerification;
    return {
      ...rest,
      ...(typeof base_confidence === "number" &&
      Number.isFinite(base_confidence)
        ? { base_confidence }
        : {}),
      ...(strength === "corroborada" || strength === "isolada"
        ? { strength }
        : {}),
    };
  } catch {
    return null;
  }
}
