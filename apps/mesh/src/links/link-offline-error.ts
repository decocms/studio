/**
 * Thrown / returned when a `runLocally=true` request cannot reach the
 * user's link daemon. The cluster surfaces this as a 409 response on
 * `POST /messages` (Phase 4) so the user can see a clear "your link is
 * offline" or "your link is missing capability X" message without the
 * request being silently queued.
 */
export type LinkOfflineReason =
  | "user_desktop_link_offline"
  | "user_desktop_link_capability_missing";

export class LinkOfflineError extends Error {
  readonly code: LinkOfflineReason;
  readonly activeCapabilities?: string[];

  constructor(reason: LinkOfflineReason, activeCapabilities?: string[]) {
    super(`link unavailable: ${reason}`);
    this.name = "LinkOfflineError";
    this.code = reason;
    this.activeCapabilities = activeCapabilities;
  }
}
