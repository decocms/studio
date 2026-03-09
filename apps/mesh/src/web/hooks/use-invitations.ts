/**
 * useInvitations Hook
 *
 * Provides React hooks for working with organization invitations.
 * Uses Suspense for loading states - wrap components in <Suspense> and <ErrorBoundary>.
 */

import { KEYS } from "@/web/lib/query-keys";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { authClient } from "@/web/lib/auth-client";
import { toast } from "sonner";

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  organizationId: string;
  inviterId: string;
}

interface OrganizationData {
  id: string;
  name: string;
  slug: string;
  invitations?: Invitation[];
}

/**
 * Hook to get all organization invitations
 *
 * @returns Query result with invitations data (uses Suspense for loading, ErrorBoundary for errors)
 */
export function useInvitations() {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useSuspenseQuery({
    queryKey: KEYS.invitations(locator),
    // Override global staleTime: invitations on the Members page should
    // always be fresh. A 60-second default cache window can hide newly
    // created invites when navigating back to the page.
    staleTime: 0,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "ORGANIZATION_GET",
        arguments: {},
      })) as { structuredContent?: unknown };
      const orgData = (result.structuredContent ??
        result) as OrganizationData | null;

      return orgData?.invitations ?? [];
    },
  });
}

/**
 * Hook to cancel an invitation
 */
export function useInvitationActions() {
  const { locator } = useProjectContext();
  const queryClient = useQueryClient();

  const cancelMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await authClient.organization.cancelInvitation({
        invitationId,
      });

      if (result?.error) {
        throw new Error(result.error.message);
      }

      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.invitations(locator) });
      toast.success("Invitation cancelled");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to cancel invitation",
      );
    },
  });

  return {
    cancel: cancelMutation,
  };
}
