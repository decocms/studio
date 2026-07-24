/**
 * useInvitations Hook
 *
 * Provides React hooks for working with organization invitations.
 * Uses Suspense for loading states - wrap components in <Suspense> and <ErrorBoundary>.
 */

import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useOrgAuthClient } from "@/hooks/use-org-auth-client";
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
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  return useSuspenseQuery({
    queryKey: KEYS.invitations(locator),
    queryFn: async () => {
      const orgData = (await studio.call(
        "ORGANIZATION_GET",
        {},
      )) as OrganizationData | null;

      return orgData?.invitations ?? [];
    },
  });
}

/**
 * Hook to cancel an invitation
 */
export function useInvitationActions() {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const queryClient = useQueryClient();

  const cancelMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await orgAuth.organization.cancelInvitation({
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
