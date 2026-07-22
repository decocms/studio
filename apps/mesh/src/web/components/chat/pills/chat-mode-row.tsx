import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { BranchPill } from "./branch-pill";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { useProjectContext } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";

interface PureProps {
  branchPill: ReactNode;
}

/**
 * Pure layout — used by tests. Renders the branch pill (when present) in the
 * parent flex flow. Returns null when there is nothing to show.
 *
 * The runtime choice (Cloud sandbox vs This device) is NOT surfaced here — it
 * lives in the "Smart" model selector's Cloud ⟷ This device toggle, which
 * writes through the same `pendingAgentOption`. A standalone pill here was
 * redundant, so this row only carries the branch pill.
 */
export function ChatModeRowPure({ branchPill }: PureProps) {
  if (!branchPill) return null;
  return <>{branchPill}</>;
}

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
}

/**
 * Smart wrapper. Renders the BranchPill for agents imported from GitHub —
 * `metadata.githubRepo` exists AND has an attached `connectionId` (an
 * authenticated user repo, not a public-template clone). Start Website agents
 * populate `metadata.githubRepo.url` for the template but leave `connectionId`
 * unset; branches aren't meaningful there.
 *
 * Locked flag is derived from `useOptionalChatStream().messages.length > 0`.
 */
export function ChatModeRow({ virtualMcp, currentBranch }: SmartProps) {
  const stream = useOptionalChatStream();
  const taskCtx = useOptionalChatTask();
  const locked =
    (stream?.messages ?? []).length > 0 || (taskCtx?.isThreadLocked ?? false);
  const setCurrentTaskBranch = taskCtx?.setCurrentTaskBranch;

  const githubRepo = getActiveGithubRepo(virtualMcp);
  const connectionId = githubRepo?.connectionId;

  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const userLabel = session?.user?.name ?? session?.user?.email?.split("@")[0];
  const { org } = useProjectContext();

  const branchPill =
    githubRepo && connectionId ? (
      <BranchPill
        orgId={org.id}
        orgSlug={org.slug}
        userId={userId}
        userLabel={userLabel}
        virtualMcpId={virtualMcp?.id ?? ""}
        connectionId={connectionId}
        owner={githubRepo.owner}
        repo={githubRepo.name}
        sandboxMap={virtualMcp?.metadata?.sandboxMap}
        value={currentBranch}
        onChange={(next) => {
          if (setCurrentTaskBranch) void setCurrentTaskBranch(next);
        }}
        locked={locked}
        placement="chat"
      />
    ) : null;

  return <ChatModeRowPure branchPill={branchPill} />;
}
