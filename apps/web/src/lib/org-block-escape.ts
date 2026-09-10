/**
 * The one route a blocked org still renders: its infrastructure billing page,
 * so the org can settle the notice without going through support.
 *
 * Kept to that single page rather than the whole billing settings group — the
 * group also holds AI provider credentials, which are ordinary org
 * configuration and stay behind the block (the server refuses those writes
 * regardless of what the client routes to).
 */
const BILLING_ESCAPE_SUFFIX = "/settings/infra-billing";

/** Whether `pathname` is the billing page a blocked org may still open. */
export function isBillingEscapeHatch(pathname: string): boolean {
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalized.endsWith(BILLING_ESCAPE_SUFFIX);
}
