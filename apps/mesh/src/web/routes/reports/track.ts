import posthog from "posthog-js";
import type { CaptureOptions, Properties } from "posthog-js";
import { isPostHogInitialized } from "@/web/lib/posthog-client";

let reviewerMode = false;

/** Set at /reports route render time (module state, so it lands before any
 *  child component captures — effects would run too late) and cleared on
 *  unmount. Reviewer sessions (?key=) flag every report event with
 *  `report_preview` instead of polluting the production funnel. */
export function setReportReviewerMode(on: boolean): void {
  reviewerMode = on;
}

/** posthog.capture for report-funnel events — merges the reviewer flag.
 *  Direct posthog (not the `track` wrapper) because CTA clicks need
 *  `{transport: "sendBeacon"}`; the init-deferral guard is kept. */
export function captureReport(
  event: string,
  props?: Properties,
  options?: CaptureOptions,
): void {
  if (!isPostHogInitialized()) return;
  posthog.capture(
    event,
    { ...props, ...(reviewerMode ? { report_preview: "reviewer" } : {}) },
    options,
  );
}
