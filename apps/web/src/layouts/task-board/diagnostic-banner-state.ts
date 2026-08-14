/**
 * Pure derivation of the board's diagnostic banner — the link between the
 * Commerce Discovery diagnostic and the kanban board.
 *
 * The diagnostic's findings are pushed onto the board by the reports sync
 * (`POST /api/:org/internal/task-board/import`, `created_by = "system"`), so
 * from the board's side the integration is a matter of *telling the user where
 * those cards come from* and giving them the one action that unblocks the
 * backlog:
 *
 * - `generating` — a run is live: fixes are on their way to this board.
 * - `locked`     — a deck exists but the org hasn't bought the unlock, so the
 *                  findings can't be pushed yet. The CTA opens the report app
 *                  (where checkout lives).
 * - `ready`      — the deck is unlocked. With cards already imported the
 *                  banner counts them (provenance for `created_by = system`
 *                  rows a user never wrote); with none yet it still points at
 *                  the report.
 * - `hidden`     — no diagnostic for this org (or the read failed): the board
 *                  shows nothing extra.
 *
 * Kept UI-free so the truth table is unit-testable, mirroring
 * `hooks/commerce-diagnostic-status.ts`.
 */

import type { CommerceReportBannerStatus } from "@/hooks/commerce-diagnostic-status";

export type DiagnosticBannerKind = "hidden" | "generating" | "locked" | "ready";

export interface DiagnosticBannerState {
  kind: DiagnosticBannerKind;
  /** Report-sourced cards currently on the board (only meaningful for `ready`). */
  taskCount: number;
}

export function deriveDiagnosticBannerState(input: {
  status: CommerceReportBannerStatus;
  /** `diagnostic.locked` — true until the org buys the one-time unlock. */
  locked?: boolean | null;
  /** Cards on the board that came from the reports import. */
  reportTaskCount: number;
}): DiagnosticBannerState {
  const taskCount = Math.max(0, input.reportTaskCount);
  if (input.status === "none") return { kind: "hidden", taskCount };
  if (input.status === "generating") return { kind: "generating", taskCount };
  // Ready deck, but still behind the paywall — the findings can't land yet.
  if (input.locked) return { kind: "locked", taskCount };
  return { kind: "ready", taskCount };
}
