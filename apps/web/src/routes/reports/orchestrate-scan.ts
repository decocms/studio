/**
 * The scan lifecycle as a pure async function (no React): trigger the scan,
 * then poll the report read (and the durable run's status when we have an id)
 * until the report is ready or the run terminates. Started from a mount
 * callback ref and cancelled via AbortSignal.
 */

import { sleep } from "@decocms/shared/std";
import type { OnePager } from "@decocms/shared/reports/public-report";
import { getReport, getScanStatus, runReportScan } from "./api";
import { captureReport, REPORT_SURFACE } from "./track";

const POLL_MS = 4000;
const MAX_POLLS = 180;

export type ScanPhase = "scanning" | "pending" | "blocked" | "empty" | "error";

export interface ScanEvents {
  onPhase: (phase: ScanPhase) => void;
  onReport: (report: OnePager) => void;
}

// localStorage mark: this browser already has a scan in flight for the domain,
// so a reload lands straight on the pending screen.
type PendingMark = { startedAt?: number };
const PKEY = (d: string) => `report:pending:${d}`;
export const readPending = (d: string): PendingMark | null => {
  try {
    return JSON.parse(localStorage.getItem(PKEY(d)) ?? "null");
  } catch {
    return null;
  }
};
const writePending = (d: string) => {
  try {
    localStorage.setItem(PKEY(d), JSON.stringify({ startedAt: Date.now() }));
  } catch {
    /* ignore */
  }
};
const clearPending = (d: string) => {
  try {
    localStorage.removeItem(PKEY(d));
  } catch {
    /* ignore */
  }
};

export async function orchestrateScan(
  domain: string,
  distinctId: string | undefined,
  signal: AbortSignal,
  events: ScanEvents,
  // Viewer locale, so the finished report matches the rest of the UI.
  lang?: string,
): Promise<void> {
  try {
    captureReport("report_scan_triggered", { domain, surface: REPORT_SURFACE });
    const trig = await runReportScan({ domain, distinctId });
    if (signal.aborted) return;
    if (trig.state === "blocked") {
      clearPending(domain);
      captureReport("report_scan_failed", {
        domain,
        phase: "blocked",
        reason: "blocked",
        surface: REPORT_SURFACE,
      });
      return events.onPhase("blocked");
    }
    let id = trig.state === "running" ? trig.id : null;
    if (trig.state === "running") {
      events.onPhase("pending");
      captureReport("report_pending_screen_shown", {
        domain,
        surface: REPORT_SURFACE,
      });
      writePending(domain);
    }

    for (let i = 0; i < MAX_POLLS && !signal.aborted; i++) {
      const next = await getReport(domain, lang);
      if (signal.aborted) return;
      if (next.status === "ready") {
        clearPending(domain);
        captureReport("report_scan_completed", {
          domain,
          surface: REPORT_SURFACE,
        });
        return events.onReport(next.report);
      }
      if (id) {
        const st = await getScanStatus(id);
        if (signal.aborted) return;
        if (st.done) {
          // The run finished but publication can lag behind it — show the
          // "still assembling" note and keep polling instead of giving up.
          id = null;
          captureReport("report_run_done_deck_pending", {
            domain,
            surface: REPORT_SURFACE,
          });
          events.onPhase("empty");
        }
      }
      await sleep(POLL_MS, { signal });
    }
    if (!signal.aborted) {
      clearPending(domain);
      captureReport("report_scan_failed", {
        domain,
        phase: "empty",
        reason: "poll_timeout",
        surface: REPORT_SURFACE,
      });
      events.onPhase("empty");
    }
  } catch {
    if (!signal.aborted) {
      clearPending(domain);
      captureReport("report_scan_failed", {
        domain,
        phase: "error",
        reason: "exception",
        surface: REPORT_SURFACE,
      });
      events.onPhase("error");
    }
  }
}
