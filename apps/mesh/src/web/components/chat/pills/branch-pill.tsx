import type { SandboxMap } from "@decocms/mesh-sdk";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { GitBranch01 } from "@untitledui/icons";
import { useOptionalChatTask } from "../chat-context";
import { BranchPicker } from "../../thread/github/branch-picker";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcpId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  locked: boolean;
  placement?: "chat" | "header";
}

/**
 * Thin wrapper over `BranchPicker` that maps the chat-level `locked`
 * flag onto the picker's `disabled` prop. The picker still renders its
 * Button + Tooltip when disabled — the user just can't open the
 * popover.
 *
 * When the active thread is *thread-locked* (i.e. `thread.harness_id` is
 * captured on the server row) we replace the picker with a
 * non-clickable lock chip. Any branch change on a locked thread is a
 * no-op on submit (see `applyThreadLock`), so we surface that to the
 * user instead of silently ignoring the click.
 */
export function BranchPill({ locked, placement, ...props }: Props) {
  const taskCtx = useOptionalChatTask();
  const isThreadLocked = taskCtx?.isThreadLocked ?? false;
  const lockedBranch = taskCtx?.lockedBranch ?? null;
  const isHeader = placement === "header";

  if (isThreadLocked) {
    const branchLabel = lockedBranch ?? "(no branch)";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="branch-picker-locked"
            aria-disabled="true"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md font-mono text-xs",
              "text-muted-foreground cursor-default min-w-0 max-w-[200px]",
              isHeader
                ? "h-8 border border-input bg-background px-2.5"
                : "h-9 px-2",
            )}
          >
            <GitBranch01 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span
              className={cn(
                "min-w-0 truncate",
                isHeader
                  ? ""
                  : "transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0 @[320px]/chat-bottom:max-w-[160px] @[320px]/chat-bottom:opacity-100",
              )}
            >
              {branchLabel}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          This chat is using branch {branchLabel}. Start a new chat to use a
          different branch.
        </TooltipContent>
      </Tooltip>
    );
  }

  return <BranchPicker {...props} disabled={locked} placement={placement} />;
}
