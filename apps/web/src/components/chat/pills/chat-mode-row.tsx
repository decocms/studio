import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { BranchPill } from "./branch-pill";
import {
  draftsModeEnabled,
  useBaseBranch,
} from "../../thread/github/use-version-gate";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useProjectContext } from "@/sdk";
import {
  defaultThreadRuntime,
  readThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { authClient } from "@/lib/auth-client";
import { branchUserLabel } from "@decocms/shared/branch-name";

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
  /** Route editors can confirm before a branch change replaces local state. */
  requestBranchChange?: (change: () => void) => void;
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
  requestBranchChange,
}: SmartProps) {
  const stream = useOptionalChatStream();
  const taskCtx = useOptionalChatTask();
  const locked =
    (stream?.messages ?? []).length > 0 || (taskCtx?.isThreadLocked ?? false);
  const setCurrentTaskBranch = taskCtx?.setCurrentTaskBranch;
  const createTask = taskCtx?.createTask;
  /** A new branch only lands in CMS through a NEW (unstamped) thread: the
   *  runtime is per-thread and immutable, so a coding session on a CMS-default
   *  project has to start one rather than switch in place. */
  const createBranchAsCms =
    defaultThreadRuntime(virtualMcp?.metadata) === "cms" &&
    readThreadRuntime(taskCtx?.activeTask?.metadata, virtualMcp?.metadata) ===
      "sandbox";

  const githubRepo = getActiveGithubRepo(virtualMcp);
  const connectionId = githubRepo?.connectionId;

  const { data: session } = authClient.useSession();
  const userLabel = branchUserLabel(session?.user);
  const userId = session?.user?.id ?? "";
  const { org } = useProjectContext();

  // Production branch shown as "Produção"; one shared source with the gate.
  const baseBranch = useBaseBranch(virtualMcp, currentBranch);
  const draftsMode = draftsModeEnabled(virtualMcp);

  // Locked chat's branch is fixed: open a new chat on the picked branch.
  const onChange = (next: string) => {
    const change = () => {
      if (locked && createTask) createTask({ branch: next });
      else if (setCurrentTaskBranch) void setCurrentTaskBranch(next);
    };
    if (requestBranchChange) requestBranchChange(change);
    else change();
  };
  // Locked or CMS→sandbox: branch off into a fresh thread, don't re-point.
  const onCreateBranch = (next: string) => {
    const change = () => {
      if ((locked || createBranchAsCms) && createTask)
        createTask({ branch: next });
      else if (setCurrentTaskBranch) void setCurrentTaskBranch(next);
    };
    if (requestBranchChange) requestBranchChange(change);
    else change();
  };

  const branchPill =
    githubRepo && connectionId ? (
      <BranchPill
        // Remount per repo so the previous project's switcher state can't leak.
        key={`${connectionId}:${githubRepo.owner}/${githubRepo.name}`}
        draftsMode={draftsMode}
        userLabel={userLabel}
        virtualMcpId={virtualMcp?.id ?? ""}
        value={currentBranch}
        baseBranch={baseBranch}
        orgId={org.id}
        orgSlug={org.slug}
        userId={userId}
        connectionId={connectionId}
        owner={githubRepo.owner}
        repo={githubRepo.name}
        sandboxMap={virtualMcp?.metadata?.sandboxMap}
        onChange={onChange}
        onCreateBranch={onCreateBranch}
        locked={locked}
        placement="chat"
      />
    ) : null;

  return <ChatModeRowPure branchPill={branchPill} />;
}
