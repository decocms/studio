/** The org the URL names, read once for the shell and the `$org` route. */

import { queryOptions } from "@tanstack/react-query";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import {
  authClient,
  currentSessionUserId,
  sessionSettled,
} from "@/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { KEYS } from "@/lib/query-keys";
import { readCachedOrg, writeCachedOrg } from "@/lib/query-persist";
import { queryClient } from "@/providers/query-client";

/** What `getFullOrganization` resolves to — named so the cache seed below can
 *  be typed against it in one place. */
type ActiveOrgData = Awaited<
  ReturnType<typeof authClient.organization.getFullOrganization>
>["data"];

export function activeOrganizationQueryOptions(
  org: string | undefined,
  userId: string | undefined,
) {
  const cachedOrg = org && userId ? readCachedOrg(userId, org) : null;
  return queryOptions({
    queryKey: KEYS.activeOrganization(org),
    queryFn: async () => {
      if (!org) {
        return null;
      }

      // Not set as the session's active org: the session row is shared across tabs.
      const query = { organizationSlug: org };
      // Marked for the perf_app_bootstrap timing event (see posthog-client).
      performance.mark("mesh:active-org-fetch:start");
      const { data } = await authClient.organization
        .getFullOrganization({ query })
        .finally(() => {
          performance.mark("mesh:active-org-fetch:end");
          performance.measure(
            "mesh:active-org-fetch",
            "mesh:active-org-fetch:start",
            "mesh:active-org-fetch:end",
          );
        });

      // Don't persist archived orgs — homeRoute would just redirect off them again
      const isArchived = isOrgArchived(data);

      // homeRoute's fast redirect on next login reads this.
      if (data && !isArchived) {
        localStorage.setItem(LOCALSTORAGE_KEYS.lastOrgSlug(), org);
      }

      // Seed the user-scoped cache so the next refresh renders instantly.
      if (userId && data) {
        writeCachedOrg(userId, org, data);
      }

      return data;
    },
    /** Hydrating from the user-scoped cache keeps a reload of a known org off
     *  the network entirely. The stale `initialDataUpdatedAt` still triggers a
     *  background refetch, which flips to the access gate if membership was
     *  revoked. */
    initialData: cachedOrg ? (cachedOrg.data as ActiveOrgData) : undefined,
    initialDataUpdatedAt: cachedOrg?.updatedAt,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * The `$org` route's loader: have the org in the cache before the router
 * commits the URL that names it.
 *
 * The router publishes a new location through an external store, which React
 * renders synchronously — a transition cannot hold the old screen. So an org
 * the cache has not seen made the shell's read suspend into the shell route's
 * pending boundary, and the whole app collapsed to a spinner strip at the top
 * of the viewport for at least `defaultPendingMinMs`. Resolved here, the old
 * org stays painted until the new one renders in one step.
 *
 * Never throws: a failed read is the shell's to report, from its own query.
 */
export async function preloadActiveOrganization(org: string): Promise<void> {
  await sessionSettled();
  const userId = currentSessionUserId();
  // Signed out, a cached `null` would read as "no access" right after sign-in.
  if (!userId) return;
  await queryClient
    .ensureQueryData(activeOrganizationQueryOptions(org, userId))
    .catch(() => undefined);
}
