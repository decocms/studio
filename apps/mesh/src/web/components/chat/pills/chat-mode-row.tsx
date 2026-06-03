import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { ModePicker } from "./mode-picker";
import { BranchPill } from "./branch-pill";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { useProjectContext } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";

interface PureProps {
  branchPill: ReactNode;
  modePicker: ReactNode;
}

/**
 * Pure layout — used by tests. Each slot renders independently; the
 * component returns null only when BOTH are null.
 *
 * Renders as a fragment (no wrapping div) so the pills sit in the
 * parent flex flow with the same gap as their siblings.
 */
export function ChatModeRowPure({ branchPill, modePicker }: PureProps) {
  if (!branchPill && !modePicker) return null;
  return (
    <>
      {modePicker}
      {branchPill}
    </>
  );
}

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
}

/**
 * Smart wrapper. Composes BranchPill + ModePicker. Each pill is gated
 * by its own capability check:
 *
 *   - BranchPill:  agent was imported from GitHub — `metadata.githubRepo`
 *     exists AND has an attached `connectionId` (authenticated user
 *     repo, not a public-template clone). Start Website agents
 *     populate `metadata.githubRepo.url` for the template but leave
 *     `connectionId` unset; branches aren't meaningful there.
 *   - ModePicker:  agent is clonable
 *     (agentHasClonableSource(virtualMcp?.metadata)).
 *
 * Locked flag is derived once here from
 * `useOptionalChatStream().messages.length > 0` and passed to both.
 */
export function ChatModeRow({ virtualMcp, currentBranch }: SmartProps) {
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;
  const taskCtx = useOptionalChatTask();
  const setCurrentTaskBranch = taskCtx?.setCurrentTaskBranch;

  const clonable = agentHasClonableSource(virtualMcp?.metadata);
  const githubRepo = getActiveGithubRepo(virtualMcp);
  const connectionId = githubRepo?.connectionId;

  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const { org } = useProjectContext();

  const branchPill =
    githubRepo && connectionId ? (
      <BranchPill
        orgId={org.id}
        orgSlug={org.slug}
        userId={userId}
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

  const modePicker = clonable ? (
    <ModePicker
      locked={locked}
      currentBranch={currentBranch}
      virtualMcpId={virtualMcp?.id ?? ""}
    />
  ) : null;

  return <ChatModeRowPure branchPill={branchPill} modePicker={modePicker} />;
}
