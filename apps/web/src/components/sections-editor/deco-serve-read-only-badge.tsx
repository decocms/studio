import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import { RichCode } from "./deco-serve-notices";
import { useContentBackend } from "./use-content-backend";

/**
 * "Read-only" in the site editor's header when the connected `deco serve`
 * was started with `--read-only`: nothing can be saved. Where the connection
 * stands is said elsewhere (the Localhost row, the Preview's empty state).
 */
export function DecoServeReadOnlyBadge({
  virtualMcpId,
  branch,
}: {
  virtualMcpId: string;
  branch: string | null;
}) {
  const t = useT();
  const backend = useContentBackend(virtualMcpId, branch);
  const readOnly =
    backend.kind === "protocol" &&
    backend.source === "local" &&
    backend.describe.readOnly;
  if (!readOnly) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-testid="deco-serve-read-only"
          className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-foreground"
        >
          {t("decoServe.readOnly.label")}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <RichCode text={t("decoServe.readOnly.tooltip")} />
      </TooltipContent>
    </Tooltip>
  );
}
