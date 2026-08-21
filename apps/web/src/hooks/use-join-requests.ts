import { useCapabilities } from "@/hooks/use-capability";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Pending requests to join the active org. Returns an empty list unless the
 * caller can manage members — the LIST tool is members:manage-gated server-side,
 * so we skip the request for everyone else (avoids a 403 from the sidebar/inbox).
 */
export function usePendingJoinRequests() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { capabilities, isPrivileged } = useCapabilities();
  const canManage = isPrivileged || !!capabilities["members:manage"];

  const { data } = useQuery({
    queryKey: KEYS.organizationJoinRequests(org.id),
    queryFn: () => studio.call("ORGANIZATION_JOIN_REQUEST_LIST", {}),
    enabled: !!org.id && canManage,
  });

  return data?.requests ?? [];
}

export type PendingJoinRequest = ReturnType<
  typeof usePendingJoinRequests
>[number];

/**
 * Approve/deny mutations shared by every surface (members page, inbox).
 * Invalidates the join-request query (updates the sidebar badge + inbox) and
 * the members list (an approval adds a member).
 */
export function useJoinRequestActions() {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const t = useT();

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: KEYS.organizationJoinRequests(org.id),
    });
    queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
  };

  const approve = useMutation({
    mutationFn: (requestId: string) =>
      studio.call("ORGANIZATION_JOIN_REQUEST_APPROVE", { requestId }),
    onSuccess: () => {
      invalidate();
      toast.success(t("settings.joinRequestsSection.approved"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.joinRequestsSection.approveFailed"),
      ),
  });

  const deny = useMutation({
    mutationFn: (requestId: string) =>
      studio.call("ORGANIZATION_JOIN_REQUEST_DENY", { requestId }),
    onSuccess: () => {
      invalidate();
      toast.success(t("settings.joinRequestsSection.denied"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.joinRequestsSection.denyFailed"),
      ),
  });

  return { approve, deny };
}
