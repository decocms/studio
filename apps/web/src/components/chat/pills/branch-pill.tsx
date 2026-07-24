import type { SandboxMap } from "@/sdk";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { GitBranch01 } from "@untitledui/icons";
import { BranchPicker } from "../../thread/github/branch-picker";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  userLabel: string | null | undefined;
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
 * When `locked` is true (chat has messages or is a thread-locked thread)
 * we replace the picker with a non-clickable lock chip so the user can
 * see the active branch without being able to change it.
 */
export function BranchPill({ locked, placement, value, ...props }: Props) {
  const isHeader = placement === "header";

  if (locked) {
    const branchLabel = value ?? "(no branch)";
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
            {/* Show the branch (truncated); below `lg` (< 1024px) collapse to an
                icon-only chip — the name stays available via the tooltip. */}
            <span className="min-w-0 truncate max-lg:hidden">
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

  return <BranchPicker {...props} value={value} placement={placement} />;
}
