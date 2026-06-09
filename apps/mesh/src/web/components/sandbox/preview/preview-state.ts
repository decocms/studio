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

export interface PreviewStateInput {
  previewUrl: string | null;
  /** Daemon reported its app as paused. */
  appPaused: boolean;
  /** User explicitly stopped the sandbox. */
  userStopped: boolean;
}

export type PreviewState =
  | { kind: "starting" }
  | { kind: "suspended" }
  | { kind: "iframe"; previewUrl: string };

export function computePreviewState(input: PreviewStateInput): PreviewState {
  if (input.appPaused || input.userStopped) return { kind: "suspended" };
  if (!input.previewUrl) return { kind: "starting" };
  return { kind: "iframe", previewUrl: input.previewUrl };
}
