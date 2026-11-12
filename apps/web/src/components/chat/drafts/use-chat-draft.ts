import { useQuery } from "@tanstack/react-query";
import { createContentClient } from "@decocms/blocks/protocol";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCPNonBlocking } from "@/sdk";
import { useOptionalChatStream, useOptionalChatTask } from "../chat-context";

export interface ChatDraft {
  virtualMcpId: string;
  projectTitle: string;
  projectIcon: string | null;
  branch: string;
  changeCount: number;
  /** The agent is still working in it. */
  editing: boolean;
}

/** Re-read while the chat is open, so the card follows edits made elsewhere. */
const POLL_MS = 15_000;

/** A thread draft's pending changes, read from the hosted draft (not the editor's runtime). */
export function useDraftChanges(
  virtualMcpId: string | null | undefined,
  branch: string | null | undefined,
  options: { poll?: boolean } = {},
) {
  const { org } = useProjectContext();
  const project = useVirtualMCPNonBlocking(virtualMcpId);
  const enabled =
    !!virtualMcpId && !!branch && agentHasClonableSource(project?.metadata);
  const { data: changeCount = 0 } = useQuery({
    queryKey: KEYS.chatDraftChanges(org.slug, virtualMcpId ?? "", branch ?? ""),
    queryFn: async () => {
      const client = createContentClient({
        endpoint: new URL(
          `/api/${org.slug}/decofile/${encodeURIComponent(virtualMcpId!)}/${encodeURIComponent(branch!)}/rpc`,
          window.location.origin,
        ).href,
      });
      const result = await client.changesList();
      return result.notModified ? 0 : Object.keys(result.changes).length;
    },
    enabled,
    refetchInterval: options.poll === false ? false : POLL_MS,
    // A site that isn't v8, or not hosted, simply has no draft to show.
    retry: false,
  });
  return { project: enabled ? project : null, changeCount };
}

/** The draft this chat changed, when it changed one. */
export function useChatDraft(): ChatDraft | null {
  const task = useOptionalChatTask();
  const stream = useOptionalChatStream();
  const virtualMcpId = task?.virtualMcpId ?? null;
  const branch = task?.currentBranch ?? null;
  const { project, changeCount } = useDraftChanges(virtualMcpId, branch);

  if (!project || !virtualMcpId || !branch || changeCount === 0) return null;
  return {
    virtualMcpId,
    projectTitle: project.title,
    projectIcon: (project.icon as string | null | undefined) ?? null,
    branch,
    changeCount,
    editing:
      !!stream &&
      (stream.isRunInProgress ||
        stream.status === "streaming" ||
        stream.status === "submitted"),
  };
}
