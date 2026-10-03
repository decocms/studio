import { listOrganizationsCached } from "@/lib/auth-client";
import { readLastLocation } from "@/lib/last-location";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

/**
 * The org a bare entry (`/`, a connect link) lands in: the last org the user
 * was in, else the first org they belong to. `null` when they have none,
 * `undefined` when the org list couldn't be read.
 *
 * The last org comes first and synchronously: lastLocation's org is recorded
 * on every org-scoped navigation (orgRoute.beforeLoad), so it's current even
 * after an in-app org switch, and returning users never wait on the org-list
 * call. A stale slug self-heals: OrgAccessGate clears it and bounces to "/".
 */
export async function resolveDefaultOrgSlug(): Promise<
  string | null | undefined
> {
  const last =
    readLastLocation()?.org ??
    localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug());
  if (last) return last;
  // Archived orgs are already filtered by the helper.
  const { data: orgs } = await listOrganizationsCached();
  if (!orgs) return undefined;
  return orgs[0]?.slug ?? null;
}
