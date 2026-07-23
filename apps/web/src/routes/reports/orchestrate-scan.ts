// The scan lifecycle as a pure async function (no React): trigger the scan,
// then poll the authenticated read (and the durable run's status when we have an id)
// until the deck is ready or the run terminates. Ported from ScanGate's effect
// in the decocms landing — here it's started from a mount callback ref and
// cancelled via AbortSignal.

import { sleep } from "@decocms/shared/std";
import type { TemplateDeck } from "@decocms/shared/reports/deck-types";
import type { SlideDrop } from "@decocms/shared/reports/to-deck";
import {
  getReport,
  getScanStatus,
  isReportsUnauthorized,
  runReportScan,
} from "./api";
import { captureReport } from "./track";

const POLL_MS = 4000;
const MAX_POLLS = 180;

export type ScanPhase =
  | "scanning"
  | "pending"
  | "blocked"
  | "empty"
  | "unauthorized"
  | "error";

export interface ScanEvents {
  onPhase: (phase: ScanPhase) => void;
  onDeck: (deck: TemplateDeck) => void;
}

/** Emit one `report_slide_dropped` per slide the shared contract rejected. */
export function reportDrops(domain: string, drops?: SlideDrop[]): void {
  for (const d of drops ?? [])
    captureReport("report_slide_dropped", {
      domain,
      section_type: d.section_type,
      position: d.position,
      reason: d.reason,
      surface: "deck_v2",
    });
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
  // Viewer locale — rendered into the deck reads so the finished deck matches
  // the language the rest of the UI is in.
  lang?: string,
): Promise<void> {
  try {
    captureReport("report_scan_triggered", { domain, surface: "deck_v2" });
    const trig = await runReportScan({ domain, distinctId });
    if (signal.aborted) return;
    if (trig.state === "blocked") {
      clearPending(domain);
      captureReport("report_scan_failed", {
        domain,
        phase: "blocked",
        reason: "blocked",
        surface: "deck_v2",
      });
      return events.onPhase("blocked");
    }
    const id = trig.state === "running" ? trig.id : null;
    if (trig.state === "running") {
      events.onPhase("pending");
      captureReport("report_pending_screen_shown", {
        domain,
        surface: "deck_v2",
      });
      writePending(domain);
    }

    for (let i = 0; i < MAX_POLLS && !signal.aborted; i++) {
      const next = await getReport(domain, undefined, lang);
      if (signal.aborted) return;
      if (next.status === "ready" && next.deck) {
        clearPending(domain);
        reportDrops(domain, next.drops);
        captureReport("report_scan_completed", { domain, surface: "deck_v2" });
        return events.onDeck(next.deck);
      }
      if (id) {
        const st = await getScanStatus(id);
        if (signal.aborted) return;
        if (st.done) {
          await sleep(POLL_MS, { signal });
          const fin = await getReport(domain, undefined, lang);
          if (signal.aborted) return;
          if (fin.status === "ready" && fin.deck) {
            clearPending(domain);
            reportDrops(domain, fin.drops);
            captureReport("report_scan_completed", {
              domain,
              surface: "deck_v2",
            });
            return events.onDeck(fin.deck);
          }
          reportDrops(domain, fin.drops);
          clearPending(domain);
          captureReport("report_scan_failed", {
            domain,
            phase: "empty",
            reason: "run_finished_empty",
            surface: "deck_v2",
          });
          return events.onPhase("empty");
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
        surface: "deck_v2",
      });
      events.onPhase("empty");
    }
  } catch (error) {
    if (!signal.aborted) {
      clearPending(domain);
      const unauthorized = isReportsUnauthorized(error);
      captureReport("report_scan_failed", {
        domain,
        phase: unauthorized ? "unauthorized" : "error",
        reason: unauthorized ? "unauthorized" : "exception",
        surface: "deck_v2",
      });
      events.onPhase(unauthorized ? "unauthorized" : "error");
    }
  }
}
