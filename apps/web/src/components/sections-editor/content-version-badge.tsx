import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { ContentBackend } from "./content-backend";
import { useContentBackend } from "./use-content-backend";

/**
 * Marks a Blocks v8 site, as `isV8Schema` decided it: a backend serving a
 * `"blocksMajor": 8` schema (GitHub, the sandbox's daemon or a `deco serve`),
 * or a v8 project (its marker) whose backend is reconnecting. v7 sites, a
 * `deco serve` with no v8 schema yet, and sites still being detected show
 * nothing: the editor looks as it did before next-major Blocks.
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

/** Whether the backend's schema was found to be v8 (see the badge above). */
function showsV8Badge(backend: ContentBackend): boolean {
  if (backend.kind === "protocol") return backend.hasSchema !== false;
  // GitHub and the daemon are only probed on a v8 project; a `deco serve`
  // that isn't answering hasn't said which schema it serves.
  return backend.kind === "unavailable" && backend.source !== "local";
}
