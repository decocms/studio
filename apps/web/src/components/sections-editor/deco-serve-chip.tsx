import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";
import { useContentBackend } from "./use-content-backend";

/** The site editor's "Local server" chip: what it edits, its state, Disconnect. */
export function DecoServeChip({
  virtualMcpId,
  branch,
}: {
  virtualMcpId: string;
  branch: string | null;
}) {
  const t = useT();
  const { connection, clear } = useDecoServeConnection(virtualMcpId);
  const backend = useContentBackend(virtualMcpId, branch);
  if (!connection) return null;
  const problem =
    backend.kind === "unavailable"
      ? backend.reason === "unauthorized"
        ? t("decoServe.status.unauthorized")
        : t("decoServe.status.unreachable")
      : null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="deco-serve-chip"
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              problem
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
          >
            {t("decoServe.chip.label")}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {problem ?? t("decoServe.chip.tooltip")}
        </TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="sm" onClick={clear}>
        {t("decoServe.chip.disconnect")}
      </Button>
    </div>
  );
}
