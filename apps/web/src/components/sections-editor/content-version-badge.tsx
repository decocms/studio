import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import { isProtocolProject } from "./content-backend";
import { useContentBackend } from "./use-content-backend";

/**
 * Which Blocks generation the editor is talking to: `v8` over the content
 * protocol, `v7` over the running site (`/live/_meta`, `/.decofile`).
 * Nothing until the backend is decided — including a failed GitHub probe,
 * which leaves the generation unknown.
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
  if (backend.kind === "pending") return null;
  if (backend.kind === "unavailable" && backend.source !== "local") return null;
  const v8 = isProtocolProject(backend);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="content-version-badge"
          className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[11px] leading-4 text-muted-foreground"
        >
          {v8 ? "v8" : "v7"}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {v8 ? t("decoServe.version.v8") : t("decoServe.version.v7")}
      </TooltipContent>
    </Tooltip>
  );
}
