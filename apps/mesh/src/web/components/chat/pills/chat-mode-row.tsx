import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import type { HarnessId } from "@/harnesses";
import { useOptionalChatTask } from "../context";
import { RuntimeSwitcher } from "./runtime-switcher";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";
import { getActiveGithubRepo } from "@/web/lib/github-repo";

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
  /** Show the runtime switcher's full label. On for the spacious empty-chat
   *  landing; off (default) for the dense in-conversation composer row. */
  showRuntimeLabel?: boolean;
}

/**
 * Smart wrapper for the composer's runtime affordance. Sandbox-backed agents
 * (imported from a GitHub repo) get the `RuntimeSwitcher` — Cloud sandbox vs
 * This device — so you can pick where it runs even before the sandbox starts.
 * Non-sandbox threads show a read-only locked-runtime chip once they're bound
 * to a local coding agent.
 *
 * The branch selector no longer lives here — it moved to the toolbar
 * breadcrumb (see `ShellBreadcrumb` → `BranchCrumb`).
 */
export function ChatModeRow({
  virtualMcp,
  showRuntimeLabel = false,
}: SmartProps) {
  const taskCtx = useOptionalChatTask();

  // Once a thread is locked to a local coding agent, the model selector hides
  // its runtime toggle — surface a read-only chip so the binding stays legible.
  const lockedRuntime =
    taskCtx?.isThreadLocked && taskCtx.lockedHarness ? (
      <LockedRuntimeChip harness={taskCtx.lockedHarness} />
    ) : null;

  // Sandbox-backed agents get the runtime switcher, which also renders the
  // locked-runtime state itself, so it supersedes the LockedRuntimeChip.
  const hasSandbox = !!getActiveGithubRepo(virtualMcp);

  return hasSandbox ? (
    <RuntimeSwitcher showLabel={showRuntimeLabel} />
  ) : (
    lockedRuntime
  );
}
