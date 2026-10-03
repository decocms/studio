import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { type RedirectPayload, redirectStatus } from "./redirect-data";

/** Compact status-code badge for a redirect row (301 permanent / 307 temporary). */
export function RedirectTypeBadge({ redirect }: { redirect: RedirectPayload }) {
  const type = redirect.type;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {redirectStatus(redirect)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">
        {type === "permanent" ? "Permanent" : "Temporary"}
      </TooltipContent>
    </Tooltip>
  );
}
