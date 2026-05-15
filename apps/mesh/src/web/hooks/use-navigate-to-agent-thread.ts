import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useTaskActions } from "@/web/hooks/use-tasks";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";
import { readCachedLastThread } from "@/web/lib/read-cached-last-thread";
import { authClient } from "@/web/lib/auth-client";

/**
 * Hook for sidebar pinned-agent entry points. Resumes the user's most
 * recent thread with the target vMCP when one is in the local TanStack
 * cache; otherwise falls back to creating a new thread. The branch-carry
 * behavior (carrying the active task's branch into a brand-new thread
 * for the same vMCP) is preserved on the create path.
 *
 * Returns `{ resumed }` so the call site can emit the right analytics.
 */
export function useNavigateToAgentThread(orgSlug: string) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taskActions = useTaskActions();
  const { locator } = useProjectContext();
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  return async (targetVirtualMcpId: string): Promise<{ resumed: boolean }> => {
    const last = userId
      ? readCachedLastThread(queryClient, locator, targetVirtualMcpId, userId)
      : null;

    if (last) {
      navigate({
        to: "/$org/$taskId",
        params: { org: orgSlug, taskId: last.id },
        search: { virtualmcpid: targetVirtualMcpId },
      });
      return { resumed: true };
    }

    const taskId = crypto.randomUUID();
    const carryBranch =
      targetVirtualMcpId === search.virtualmcpid
        ? readCachedTaskBranch(queryClient, locator, params.taskId ?? "")
        : null;
    try {
      await taskActions.create.mutateAsync({
        id: taskId,
        virtual_mcp_id: targetVirtualMcpId,
        ...(carryBranch ? { branch: carryBranch } : {}),
      });
    } catch {
      // Toast already fired; navigate anyway so the route loader's
      // ensure-fallback can retry.
    }
    navigate({
      to: "/$org/$taskId",
      params: { org: orgSlug, taskId },
      search: { virtualmcpid: targetVirtualMcpId },
    });
    return { resumed: false };
  };
}
