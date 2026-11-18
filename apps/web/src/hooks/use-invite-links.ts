import { useCapabilities } from "@/hooks/use-capability";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useCanManageMembers() {
  const { capabilities, isPrivileged } = useCapabilities();
  return isPrivileged || !!capabilities["members:manage"];
}

/** Active invite links for the org; empty for callers who cannot manage members. */
export function useActiveInviteLinks() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const canManage = useCanManageMembers();

  const { data } = useQuery({
    queryKey: KEYS.organizationInviteLinks(org.id),
    queryFn: () => studio.call("ORGANIZATION_INVITE_LINK_LIST", {}),
    enabled: !!org.id && canManage,
  });

  return data?.links ?? [];
}

export type ActiveInviteLink = ReturnType<typeof useActiveInviteLinks>[number];

export function useInviteLinkActions() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.organizationInviteLinks(org.id),
    });

  const create = useMutation({
    mutationFn: async (input: { role: string; redirectPath?: string }) => {
      const link = await studio.call("ORGANIZATION_INVITE_LINK_CREATE", input);
      return { ...link, url: `${window.location.origin}${link.path}` };
    },
    onSuccess: invalidate,
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      studio.call("ORGANIZATION_INVITE_LINK_REVOKE", { id }),
    onSuccess: invalidate,
  });

  return { create, revoke };
}
