/**
 * Pure preview-state decision: maps inputs from preview.tsx into a
 * discriminated state union. Extracted so it can be unit-tested without
 * DOM/auth/SSE scaffolding.
 *
 * Priority order (highest first):
 *   errored → dev-script-failed → suspended → starting-now → no-html → iframe → never-started
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

/**
 * Terminal daemon setup-pipeline failures. Distinct from `lastStartError`
 * (the SANDBOX_START mutation rejection) — these come from the daemon AFTER it
 * came online, e.g. `bun run dev` exiting with a non-zero code.
 */
export type LifecycleFailure =
  | "clone-failed"
  | "install-failed"
  | "start-failed";

export interface PreviewStateInput {
  previewUrl: string | null;
  status: UpstreamStatus;
  htmlSupport: boolean;
  suspended: boolean;
  appPaused: boolean;
  vmStartPending: boolean;
  lastStartError: string | null;
  lifecycleFailure: LifecycleFailure | null;
  lifecycleFailureError: string | null;
  claimPhase: ClaimPhaseLike | null;
  notFound: boolean;
  userStopped: boolean;
}

export type PreviewState =
  | { kind: "never-started" }
  | { kind: "starting-now" }
  | { kind: "errored"; error: string }
  | { kind: "dev-script-failed"; failure: LifecycleFailure; error: string }
  | { kind: "suspended" }
  | { kind: "crashed"; previewUrl: string }
  | { kind: "no-html"; previewUrl: string }
  | { kind: "iframe"; previewUrl: string };

export function computePreviewState(input: PreviewStateInput): PreviewState {
  if (input.lastStartError) {
    return { kind: "errored", error: input.lastStartError };
  }
  if (input.lifecycleFailure) {
    return {
      kind: "dev-script-failed",
      failure: input.lifecycleFailure,
      error: input.lifecycleFailureError ?? `Sandbox ${input.lifecycleFailure}`,
    };
  }
  if (input.suspended || input.appPaused) {
    return { kind: "suspended" };
  }
  // User explicitly stopped the VM. Skip the `notFound` / `claimPhase` checks below that would otherwise force `starting-now` while the SSE still emits `gone` and the sandboxMap invalidation drains.
  if (input.userStopped) {
    return { kind: "never-started" };
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
  // previewUrl set: decide between iframe / crashed / no-html / starting-now.
  // htmlSupport is sticky across `running` → `crashed`, so an established
  // iframe stays mounted across transient drops. When the dev server crashes
  // and we never latched htmlSupport, surface the dedicated crashed state
  // instead of the misleading "no web page at this URL" empty state.
  if (input.status === "online" || input.status === "offline") {
    if (input.htmlSupport) {
      return { kind: "iframe", previewUrl: input.previewUrl };
    }
    if (input.status === "offline") {
      return { kind: "crashed", previewUrl: input.previewUrl };
    }
    return { kind: "no-html", previewUrl: input.previewUrl };
  }
  return { kind: "starting-now" };
}
