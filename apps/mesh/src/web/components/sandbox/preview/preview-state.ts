/**
 * Pure preview-state decision. Collapsed model: the sandbox daemon's HTTP
 * proxy renders every "not live" case (no dev server, starting, dev crashed,
 * no web page) as served HTML, so the frontend only needs:
 *
 *   suspended → starting → iframe
 *
 * `iframe` is shown whenever a previewUrl exists; whatever the daemon serves
 * (live app, "connecting", "no dev server", "no web page", or the raw browser
 * connection-refused page when the link is down) is the displayed state.
 */

import type { SandboxStartErrorCode } from "@/shared/sandbox-start-errors";

export interface SandboxStartError {
  code: SandboxStartErrorCode | null;
  message: string;
}

export interface PreviewStateInput {
  previewUrl: string | null;
  /** Daemon reported its app as paused. */
  appPaused: boolean;
  /** User explicitly stopped the sandbox. */
  userStopped: boolean;
  /** SANDBOX_START rejected (e.g. GitHub not authenticated) with no VM yet. */
  startError: SandboxStartError | null;
  /**
   * The active thread belongs to another member and the current user hasn't
   * acknowledged opening it yet. While set, auto-start is held back and the
   * preview shows a confirmation gate instead of silently booting a sandbox on
   * the other member's branch. `label` identifies the thread (its branch, or
   * title as a fallback). Null once acknowledged, or on the user's own thread.
   */
  othersThreadGate?: { label: string } | null;
}

export type PreviewState =
  | { kind: "starting" }
  | { kind: "suspended" }
  | { kind: "errored"; error: SandboxStartError }
  | { kind: "othersThread"; label: string }
  | { kind: "iframe"; previewUrl: string };

export function computePreviewState(input: PreviewStateInput): PreviewState {
  // Gate wins before we ever spin the booting overlay: don't birth a sandbox on
  // another member's branch until the user confirms. Once a previewUrl exists
  // the user already acknowledged and the VM is theirs, so the running preview
  // wins over a stale gate.
  if (input.othersThreadGate && !input.previewUrl) {
    return { kind: "othersThread", label: input.othersThreadGate.label };
  }
  if (input.appPaused || input.userStopped) return { kind: "suspended" };
  // A start error with no live VM is terminal: show it instead of spinning
  // on the booting overlay forever. Once a previewUrl exists the running
  // sandbox wins (a failed restart shouldn't blank a working preview).
  if (input.startError && !input.previewUrl) {
    return { kind: "errored", error: input.startError };
  }
  if (!input.previewUrl) return { kind: "starting" };
  return { kind: "iframe", previewUrl: input.previewUrl };
}
