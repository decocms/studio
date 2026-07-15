import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { BranchPill } from "./branch-pill";
import { RuntimeSwitcher } from "./runtime-switcher";
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
 * This pure component only handles the branch pill. The smart `ChatModeRow`
 * below renders the sandbox-backed agent's `RuntimeSwitcher` (Cloud sandbox vs
 * This device) alongside it; the chat model runtime itself is still chosen in
 * the model selector.
 */
export function ChatModeRowPure({ branchPill }: PureProps) {
  if (!branchPill) return null;
  return <>{branchPill}</>;
}

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
  /** Show the runtime switcher's full label. On for the spacious empty-chat
   *  landing; off (default) for the dense in-conversation composer row. */
  showRuntimeLabel?: boolean;
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
export function ChatModeRow({
  virtualMcp,
  currentBranch,
  showRuntimeLabel = false,
}: SmartProps) {
  const stream = useOptionalChatStream();
  const taskCtx = useOptionalChatTask();
  const locked =
    (stream?.messages ?? []).length > 0 || (taskCtx?.isThreadLocked ?? false);
  const setCurrentTaskBranch = taskCtx?.setCurrentTaskBranch;

  const githubRepo = getActiveGithubRepo(virtualMcp);
  const connectionId = githubRepo?.connectionId;
  // Sandbox-backed agents (imported from a repo) get the runtime switcher —
  // Cloud sandbox vs This device — right next to the branch pill, so you can
  // pick where it runs even before the sandbox starts. Once the thread is
  // locked, RuntimeSwitcher hides itself because there is no longer a choice.
  const hasSandbox = !!githubRepo;

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

  return (
    <>
      {hasSandbox && <RuntimeSwitcher showLabel={showRuntimeLabel} />}
      <ChatModeRowPure branchPill={branchPill} />
    </>
  );
}
