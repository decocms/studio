/**
 * Detect auto-task quota/subscription errors.
 * The backend prefixes these with `[SUBSCRIPTION_REQUIRED]` (same convention
 * as `[CREDITS]`, see `../chat/is-credit-error.ts`) and distinguishes the
 * three cases in the text after the prefix — see `apps/api/src/billing/
 * task-quota.ts`'s `QUOTA_MESSAGES`.
 *
 * Extracted as a pure .ts module so it can be tested without dragging in
 * @decocms/ui transitively.
 */
const SUBSCRIPTION_REQUIRED_PREFIX = "[SUBSCRIPTION_REQUIRED]";

export type SubscriptionErrorKind =
  /** The org's 3 lifetime free auto-task runs are used up — sell the
   *  subscription. */
  | "trial_exhausted"
  /** A paying org used its 10-per-cycle quota — no CTA, it renews on its own. */
  | "monthly_exhausted"
  /** THIS task hit its 5 re-run cap — no CTA, the fix is a new task. */
  | "runs_exhausted";

export function subscriptionErrorKind(
  error: Error | null | undefined,
): SubscriptionErrorKind | null {
  if (!error?.message.startsWith(SUBSCRIPTION_REQUIRED_PREFIX)) return null;
  if (error.message.includes("used its free task executions")) {
    return "trial_exhausted";
  }
  if (error.message.includes("used its monthly task executions")) {
    return "monthly_exhausted";
  }
  if (error.message.includes("reached its execution limit")) {
    return "runs_exhausted";
  }
  return null;
}
