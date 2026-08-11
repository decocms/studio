import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { REDIRECT_STATUS, type RedirectType } from "./redirect-data";

/** Compact status-code badge for a redirect row (301 permanent / 307 temporary). */
export function RedirectTypeBadge({ type }: { type: RedirectType }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {REDIRECT_STATUS[type]}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">
        {type === "permanent" ? "Permanent" : "Temporary"}
      </TooltipContent>
    </Tooltip>
  );
}
