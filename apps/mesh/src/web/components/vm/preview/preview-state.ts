/**
 * Pure preview-state decision: maps inputs from preview.tsx into a
 * discriminated state union. Extracted so it can be unit-tested without
 * DOM/auth/SSE scaffolding.
 *
 * Priority order (highest first):
 *   errored → suspended → starting-now → no-html → iframe → never-started
 *
 * `status === "online" || "offline"` is the "ever-responded" latch:
 * once the daemon has seen the upstream answer, the iframe stays mounted
 * across transient drops (htmlSupport is sticky on offline at the source).
 */

/**
 * Upstream HTTP probe status, projected from `LifecycleState.phase` by
 * preview.tsx. `online` = `running` (probe answered), `offline` = `crashed`
 * (was running, stopped responding), `booting` = anything else.
 */
export type UpstreamStatus = "booting" | "online" | "offline";
export type ClaimPhaseLike = { kind: string };

export interface PreviewStateInput {
  previewUrl: string | null;
  status: UpstreamStatus;
  htmlSupport: boolean;
  suspended: boolean;
  appPaused: boolean;
  vmStartPending: boolean;
  lastStartError: string | null;
  claimPhase: ClaimPhaseLike | null;
  notFound: boolean;
}

export type PreviewState =
  | { kind: "never-started" }
  | { kind: "starting-now" }
  | { kind: "errored"; error: string }
  | { kind: "suspended" }
  | { kind: "no-html"; previewUrl: string }
  | { kind: "iframe"; previewUrl: string };

export function computePreviewState(input: PreviewStateInput): PreviewState {
  if (input.lastStartError) {
    return { kind: "errored", error: input.lastStartError };
  }
  if (input.suspended || input.appPaused) {
    return { kind: "suspended" };
  }
  if (input.notFound) {
    return { kind: "starting-now" };
  }
  if (!input.previewUrl && input.vmStartPending) {
    return { kind: "starting-now" };
  }
  if (
    !input.previewUrl &&
    input.claimPhase &&
    input.claimPhase.kind !== "failed"
  ) {
    return { kind: "starting-now" };
  }
  if (!input.previewUrl) {
    return { kind: "never-started" };
  }
  // previewUrl set: decide between iframe / no-html / starting-now.
  if (input.status === "online" || input.status === "offline") {
    if (input.htmlSupport) {
      return { kind: "iframe", previewUrl: input.previewUrl };
    }
    return { kind: "no-html", previewUrl: input.previewUrl };
  }
  return { kind: "starting-now" };
}
