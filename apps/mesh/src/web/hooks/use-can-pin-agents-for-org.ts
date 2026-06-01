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
 */
export function useCanPinAgentsForOrg(): boolean {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const { data: role } = useQuery({
    queryKey: [...KEYS.members(locator), "active-member", userId] as const,
    queryFn: async () => {
      const result = await orgAuth.organization.getActiveMember();
      if (result.error) return undefined;
      return result.data?.role as string | undefined;
    },
    enabled: Boolean(userId),
    staleTime: 60_000,
  });

  return isOrgAdminRole(role);
}
