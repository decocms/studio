/**
 * Org metadata is CLIENT-WRITABLE: Better Auth's public
 * `POST /api/auth/organization/create` declares `metadata` on its request body
 * and stores whatever it is given. So no privileged value may be read back out
 * of it, and none may be left sitting in it for future code to trust.
 *
 * `initialCreditCents` used to travel exactly that way — an ordinary session
 * could POST `{"metadata":{"initialCreditCents":100000}}` and mint $1,000 into
 * its own gateway ledger, repeatably (org creation is unlimited). The per-org
 * override is gone; a control-plane operator who wants to fund one org calls
 * the gateway's authenticated `/api/admin/credits` directly, which is what
 * `creditGatewayTopUp` already does and is idempotent per referenceId.
 *
 * This list is the deny-list for the creation boundary. Add to it any time a
 * privileged name would otherwise be readable from metadata.
 */
const PRIVILEGED_METADATA_KEYS = ["initialCreditCents"] as const;

/**
 * Strip privileged keys from client-supplied org metadata. Returns the metadata
 * to persist, or `undefined` when nothing survives (so no empty bag is stored).
 * Accepts the raw string form Better Auth may hand over as well as an object.
 */
export function stripPrivilegedMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  let bag: unknown = metadata;
  if (typeof bag === "string") {
    try {
      bag = JSON.parse(bag);
    } catch {
      return undefined;
    }
  }
  if (typeof bag !== "object" || bag === null) return undefined;
  const clean: Record<string, unknown> = { ...(bag as Record<string, unknown>) };
  for (const key of PRIVILEGED_METADATA_KEYS) delete clean[key];
  return Object.keys(clean).length > 0 ? clean : undefined;
}
