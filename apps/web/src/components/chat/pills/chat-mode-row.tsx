import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { BranchPill } from "./branch-pill";
import { useBaseBranch } from "../../thread/repository/use-version-gate";
import {
  getActiveRepository,
  hasRepoCredential,
  repoTargetKey,
  repoToolTarget,
} from "@/lib/repository-binding";
import { useProjectContext } from "@/sdk";
import {
  defaultThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useBlocksV8Project } from "@/hooks/use-blocks-v8-project";
import { authClient } from "@/lib/auth-client";
import { branchUserLabel } from "@decocms/shared/branch-name";

interface PureProps {
  branchPill: ReactNode;
}

/**
 * Pure layout — used by tests. Renders the branch pill (when present) in the
 * parent flex flow. Returns null when there is nothing to show.

 */
export function ChatModeRowPure({ branchPill }: PureProps) {
  if (!branchPill) return null;
  return <>{branchPill}</>;
}

export type BranchPickAction =
  | { kind: "switch" }
  | { kind: "new-chat"; runtime?: ThreadRuntime };

/** v8 content drafts open in CMS; legacy picks preserve the coding runtime. */
export function branchPickAction(input: {
  locked: boolean;
  /** `null` while unresolved: may still be a CMS chat. */
  sessionRuntime: ThreadRuntime | null;
  draftRuntime?: ThreadRuntime;
  /** The v8 flag: content pointers must open in CMS, not as Git branches. */
  contentOnly?: boolean;
}): BranchPickAction {
  const { locked, sessionRuntime, draftRuntime } = input;
  if (input.contentOnly && draftRuntime === "cms") {
    return sessionRuntime === "cms" && !locked
      ? { kind: "switch" }
      : { kind: "new-chat", runtime: "cms" };
  }
  const escalate = draftRuntime === "sandbox" && sessionRuntime !== "sandbox";
  if (!locked && !escalate) return { kind: "switch" };
  return draftRuntime === "sandbox" || sessionRuntime === "sandbox"
    ? { kind: "new-chat", runtime: "sandbox" }
    : { kind: "new-chat" };
}

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
}

/**
 * Smart wrapper. Renders the BranchPill for agents imported from GitHub —
 * `metadata.repository` exists AND has an attached `connectionId` (an
 * authenticated user repo, not a public-template clone). Start Website agents
 * populate `metadata.repository.url` for the template but leave `connectionId`
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
  const createTask = taskCtx?.createTask;
  const sessionState = useSessionRuntime(virtualMcp?.id);
  const sessionRuntime = sessionState.runtime;
  /** A new branch only lands in CMS through a NEW (unstamped) thread: the
   *  runtime is per-thread and immutable, so a coding session on a CMS-default
   *  project has to start one rather than switch in place. */
  const createBranchAsCms =
    defaultThreadRuntime(virtualMcp?.metadata) === "cms" &&
    sessionRuntime === "sandbox";

  const repository = getActiveRepository(virtualMcp);
  const repoTarget = repoToolTarget(repository);

  const { data: session } = authClient.useSession();
  const userLabel = branchUserLabel(session?.user);
  const userId = session?.user?.id ?? "";
  const { org } = useProjectContext();

  // Production branch shown as "Produção"; one shared source with the gate.
  const baseBranch = useBaseBranch(virtualMcp, currentBranch);
  // The Localhost item is for Blocks v8 projects (their switch); v7 keeps
  // main's Advanced → Local.
  const v8 = useBlocksV8Project(virtualMcp?.id);
  // A CMS session on a Blocks v8 project edits a hosted draft even on the base
  // branch: the switcher shows it as that draft, not as "Production". v7 (and
  // a coding session) keeps main's labels.
  const baseIsDraft = v8 && sessionRuntime === "cms";

  const onChange = (next: string, draftRuntime?: ThreadRuntime) => {
    const action = branchPickAction({
      locked,
      sessionRuntime: sessionState.resolved ? sessionRuntime : null,
      draftRuntime,
      contentOnly: v8,
    });
    if (action.kind === "new-chat" && createTask) {
      createTask({
        branch: next,
        ...(action.runtime ? { runtime: action.runtime } : {}),
      });
    } else if (setCurrentTaskBranch) {
      void setCurrentTaskBranch(next);
    }
  };
  // Locked or CMS→sandbox: branch off into a fresh thread, don't re-point.
  const onCreateBranch = (next: string) => {
    if ((locked || createBranchAsCms) && createTask)
      createTask({ branch: next });
    else if (setCurrentTaskBranch) void setCurrentTaskBranch(next);
  };
  // Adopting a branch/PR opens a sandbox coding session on its code.
  const onAdoptBranch = createTask
    ? (next: string) => createTask({ runtime: "sandbox", branch: next })
    : undefined;

  const branchPill =
    repository && hasRepoCredential(repoTarget) ? (
      <BranchPill
        // Remount per repo so the previous project's switcher state can't leak.
        key={`${repoTargetKey(repoTarget)}:${repository.owner}/${repository.name}`}
        userLabel={userLabel}
        virtualMcpId={virtualMcp?.id ?? ""}
        isV8={v8}
        value={currentBranch}
        baseBranch={baseBranch}
        baseIsDraft={baseIsDraft}
        orgId={org.id}
        orgSlug={org.slug}
        userId={userId}
        target={repoTarget}
        owner={repository.owner}
        repo={repository.name}
        sandboxMap={virtualMcp?.metadata?.sandboxMap}
        onChange={onChange}
        onCreateBranch={onCreateBranch}
        onAdoptBranch={onAdoptBranch}
        locked={locked}
        placement="chat"
      />
    ) : null;

  return <ChatModeRowPure branchPill={branchPill} />;
}
