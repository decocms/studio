import { GitHubIcon } from "@/web/components/icons/github-icon";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

export interface RepoRowProps {
  repo: { owner: string; name: string; url: string } | null;
  className?: string;
}

export function RepoRow({ repo, className }: RepoRowProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label>Repository</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3"
            tabIndex={0}
          >
            <GitHubIcon size={20} className="shrink-0 text-foreground/60" />
            <div className="min-w-0 flex-1">
              {repo ? (
                <>
                  <div className="truncate text-sm font-medium">
                    {repo.owner}/{repo.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {repo.url}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No repository connected
                </div>
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          The connected GitHub repository for this agent. Manage in Connections.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
