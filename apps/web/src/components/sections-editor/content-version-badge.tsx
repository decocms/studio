import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useContentBackend } from "./use-content-backend";

/**
 * Marks a Blocks v8 site: one edited over the content protocol, from a
 * GitHub schema with `"blocksMajor": 8` or a `deco serve` (connected or
 * reconnecting). v7 sites, and sites still being detected, show nothing:
 * the editor looks as it did before next-major Blocks.
 */
export function ContentVersionBadge({
  virtualMcpId,
  branch,
}: {
  virtualMcpId: string;
  branch: string | null;
}) {
  const t = useT();
  const backend = useContentBackend(virtualMcpId, branch);
  if (backend.kind !== "protocol" && backend.kind !== "unavailable") {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="content-version-badge"
          className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[11px] leading-4 text-muted-foreground"
        >
          v8
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {t("decoServe.version.v8")}
      </TooltipContent>
    </Tooltip>
  );
}
