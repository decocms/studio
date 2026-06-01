import { authClient } from "@/web/lib/auth-client";
import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

function isOrgAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Whether the current user can pin/unpin agents for all org members
 * (`connections.pinned` on the server).
 *
 * Uses `listMembers` rather than `getActiveMember`: the app resolves org
 * from the URL and intentionally does not persist `activeOrganizationId`
 * on the session (multi-tab safety), so getActiveMember returns null.
 */
export function useCanPinAgentsForOrg(): boolean {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const { data: membersResult } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
    enabled: Boolean(userId),
    staleTime: 60_000,
  });

  const members = (membersResult?.data?.members ?? []) as Array<{
    userId: string;
    role?: string | null;
  }>;
  const role = members.find((member) => member.userId === userId)?.role;

  return isOrgAdminRole(role ?? undefined);
}
