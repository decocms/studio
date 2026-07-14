import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import type { HarnessId } from "@/harnesses";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { BranchPill } from "./branch-pill";
import { RuntimeSwitcher } from "./runtime-switcher";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";
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
 * The runtime (cloud org router vs. a local coding agent) is no longer a pill
 * here — it lives inside the model selector. This row is now just the GitHub
 * branch affordance.
 */
export function ChatModeRowPure({ branchPill }: PureProps) {
  if (!branchPill) return null;
  return <>{branchPill}</>;
}

const LOCAL_RUNTIME: Partial<
  Record<HarnessId, { label: string; icon: ReactNode }>
> = {
  "claude-code": { label: "Claude Code", icon: <ClaudeCodeIcon size={14} /> },
  codex: { label: "Codex", icon: <CodexIcon size={14} /> },
};

/**
 * Read-only chip shown once a thread is locked to a local coding agent. The
 * runtime is normally chosen (and re-chosen) inside the model selector, but a
 * locked thread can't switch runtimes — this tells the user which local agent
 * the chat is bound to and why the model selector no longer offers the toggle.
 * Only local CLIs surface it; a cloud thread stays chrome-free.
 */
function LockedRuntimeChip({ harness }: { harness: HarnessId }) {
  const runtime = LOCAL_RUNTIME[harness];
  if (!runtime) return null;
  const message = `This chat is using ${runtime.label}. Start a new chat to use a different runtime.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="mode-picker-locked"
          aria-label={message}
          className="inline-flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground"
        >
          {runtime.icon}
          <span className="truncate">{runtime.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
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

  // Once a thread is locked to a local coding agent, the model selector hides
  // its runtime toggle — surface a read-only chip so the binding stays legible.
  const lockedRuntime =
    taskCtx?.isThreadLocked && taskCtx.lockedHarness ? (
      <LockedRuntimeChip harness={taskCtx.lockedHarness} />
    ) : null;

  const githubRepo = getActiveGithubRepo(virtualMcp);
  const connectionId = githubRepo?.connectionId;
  // Sandbox-backed agents (imported from a repo) get the runtime switcher —
  // Cloud sandbox vs This device — right next to the branch pill, so you can
  // pick where it runs even before the sandbox starts. It also renders the
  // locked-runtime state itself, so it supersedes the LockedRuntimeChip here.
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
      {hasSandbox ? <RuntimeSwitcher /> : lockedRuntime}
      <ChatModeRowPure branchPill={branchPill} />
    </>
  );
}
