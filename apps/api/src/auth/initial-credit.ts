import { MAX_SIGNUP_GRANT_CENTS } from "@/billing/gateway-admin";

/**
 * Extract a control-plane-supplied initial AI-credit override (in cents) from
 * an org's Better Auth metadata, which reaches the afterCreate hook as either
 * an object or a raw JSON string. Returns undefined for anything that isn't a
 * finite non-negative integer within the cap, so a malformed value falls back
 * to the deployment default rather than granting a garbage amount.
 */
export function readInitialCreditCents(metadata: unknown): number | undefined {
  let bag: unknown = metadata;
  if (typeof bag === "string") {
    try {
      bag = JSON.parse(bag);
    } catch {
      return undefined;
    }
  }
  if (typeof bag !== "object" || bag === null) return undefined;
  const value = (bag as Record<string, unknown>).initialCreditCents;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SIGNUP_GRANT_CENTS
  ) {
    return undefined;
  }
  return value;
}
