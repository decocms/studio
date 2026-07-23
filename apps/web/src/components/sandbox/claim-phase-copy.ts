import type { ClaimPhase } from "./hooks/sandbox-events-context";

/**
 * Shared copy for pre-daemon claim phases. The booting visual uses `long`
 * (overlay headline, room to breathe) and the thread/github header uses
 * `short` (button-sized character budget). Keeping both variants on the
 * same record means adding a new `ClaimPhase["kind"]` is a single edit
 * and the type-system enforces that both surfaces stay in lock-step.
 *
 * `ready` and `failed` are intentionally absent from this table:
 *   - `ready`  — claim handle is up but lifecycle hasn't yet emitted its
 *                first event; callers fall through to their phase-step
 *                copy ("Reserving sandbox" / generic) so we don't render
 *                stale claim-phase text past the claim window.
 *   - `failed` — terminal pre-daemon failure; callers fall through to
 *                generic surfacing today (a unified "Provision failed"
 *                pill across surfaces is tracked as a follow-up).
 */
export const CLAIM_PHASE_COPY: Record<
  Exclude<ClaimPhase["kind"], "ready" | "failed">,
  { long: string; short: string }
> = {
  claiming: { long: "Reserving sandbox", short: "Reserving sandbox" },
  "waiting-for-capacity": {
    long: "Waiting for cluster capacity",
    short: "Waiting for capacity",
  },
  "pulling-image": {
    long: "Downloading sandbox image",
    short: "Downloading image",
  },
  "starting-container": {
    long: "Starting your sandbox",
    short: "Starting container",
  },
  "warming-daemon": {
    long: "Connecting to your sandbox",
    short: "Connecting to sandbox",
  },
};
