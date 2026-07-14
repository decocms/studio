import type { SandboxMap } from "@decocms/mesh-sdk";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
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
}

/**
 * Thin wrapper over `BranchPicker` used by the toolbar breadcrumb
 * (`ShellBreadcrumb` → `BranchCrumb`).
 *
 * When `locked` is true (the thread's runtime is pinned — `harness_id` set) we
 * replace the interactive picker with a non-clickable lock chip so the user can
 * still see the active branch without being able to change it.
 */
export function BranchPill({ locked, value, ...props }: Props) {
  if (locked) {
    const branchLabel = value ?? "(no branch)";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="branch-picker-locked"
            aria-disabled="true"
            className="inline-flex items-center h-8 gap-1.5 px-2.5 rounded-md font-mono text-xs text-muted-foreground cursor-default min-w-0 max-w-[200px]"
          >
            <GitBranch01 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{branchLabel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          This chat is using branch {branchLabel}. Start a new chat to use a
          different branch.
        </TooltipContent>
      </Tooltip>
    );
  }

  return <BranchPicker {...props} value={value} />;
}
