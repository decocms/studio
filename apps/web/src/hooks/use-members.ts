/**
 * useMembers Hook
 *
 * Provides React hooks for working with organization members using Better Auth.
 * Uses Suspense for loading states - wrap components in <Suspense> and <ErrorBoundary>.
 */

import { useOrgAuthClient } from "@/hooks/use-org-auth-client";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

const MEMBERS_STALE_TIME = 5 * 60 * 1000;

/**
 * Hook to get all organization members
 *
 * @returns Query result with members data (uses Suspense for loading, ErrorBoundary for errors)
 *
 * @example
 * ```tsx
 * <Suspense fallback={<Loader />}>
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 * </Suspense>
 *
 * function MyComponent() {
 *   const { data } = useMembers();
 *   const members = data?.data?.members ?? [];
 *   return <div>{members.length} members</div>;
 * }
 * ```
 */
export function useMembers() {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();

  return useSuspenseQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
  });
}

/**
 * Non-Suspense variant of {@link useMembers}, sharing the same query key/cache.
 * Use in components that must render before members resolve (e.g. a picker
 * trigger that can't be allowed to suspend). `enabled` lets callers defer the
 * fetch until the data is actually needed.
 */
export function useMembersQuery({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();

  return useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
    staleTime: MEMBERS_STALE_TIME,
    enabled,
  });
}
