/**
 * Pure preview-state decision: maps inputs from preview.tsx into a
 * discriminated state union. Extracted so it can be unit-tested without
 * DOM/auth/SSE scaffolding.
 *
 * Priority order (highest first):
 *   error → suspended → booting → no-html → iframe → idle
 *
 * `status === "online" || "offline"` is the "ever-responded" latch:
 * once the daemon has seen the upstream answer, the iframe stays mounted
 * across transient drops (htmlSupport is sticky on offline at the source).
 */

import type { UpstreamStatus } from "../upstream-status";
export type { UpstreamStatus };
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
  | { kind: "idle" }
  | { kind: "booting" }
  | { kind: "error"; error: string }
  | { kind: "suspended" }
  | { kind: "no-html"; previewUrl: string }
  | { kind: "iframe"; previewUrl: string };

export function computePreviewState(input: PreviewStateInput): PreviewState {
  if (input.lastStartError) {
    return { kind: "error", error: input.lastStartError };
  }
  if (input.suspended || input.appPaused) {
    return { kind: "suspended" };
  }
  if (input.notFound) {
    return { kind: "booting" };
  }
  if (!input.previewUrl && input.vmStartPending) {
    return { kind: "booting" };
  }
  if (
    !input.previewUrl &&
    input.claimPhase &&
    input.claimPhase.kind !== "failed"
  ) {
    return { kind: "booting" };
  }
  if (!input.previewUrl) {
    return { kind: "idle" };
  }
  // previewUrl set: decide between iframe / no-html / booting.
  if (input.status === "online" || input.status === "offline") {
    if (input.htmlSupport) {
      return { kind: "iframe", previewUrl: input.previewUrl };
    }
    return { kind: "no-html", previewUrl: input.previewUrl };
  }
  return { kind: "booting" };
}
