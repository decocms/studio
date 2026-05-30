/**
 * useMembers Hook
 *
 * Provides React hooks for working with organization members using Better Auth.
 * Uses Suspense for loading states - wrap components in <Suspense> and <ErrorBoundary>.
 */

import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useSuspenseQuery } from "@tanstack/react-query";

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
