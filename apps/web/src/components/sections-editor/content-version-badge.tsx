import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { ContentBackend } from "./content-backend";
import { useContentBackend } from "./use-content-backend";

/**
 * Marks a Blocks v8 site (its "Blocks v8 site" switch on): a content-protocol
 * backend with a schema (GitHub, a sandbox's working tree or a `deco
 * serve`), or a hosted one while it reconnects. v7 projects, a `deco serve`
 * with no schema yet, and backends still connecting show nothing: the
 * editor looks as it did before next-major Blocks.
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
  if (!showsV8Badge(backend)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="content-version-badge"
          className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-2xs leading-4 text-muted-foreground"
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

/** Whether the badge shows (see above). */
function showsV8Badge(backend: ContentBackend): boolean {
  if (backend.kind === "protocol") return backend.hasSchema !== false;
  // `unavailable` is only ever a v8 project; a `deco serve` that isn't
  // answering hasn't said whether it serves a schema.
  return backend.kind === "unavailable" && backend.source !== "local";
}
