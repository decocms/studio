import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";
import { endpointHost } from "./deco-serve-connection";
import { RichCode, serveProblemShort } from "./deco-serve-notices";
import { useContentBackend } from "./use-content-backend";

/** The site editor's "Local server" chip: what it edits and its state. */
export function DecoServeChip({
  virtualMcpId,
  branch,
}: {
  virtualMcpId: string;
  branch: string | null;
}) {
  const t = useT();
  const { connection } = useDecoServeConnection(virtualMcpId);
  const backend = useContentBackend(virtualMcpId, branch);
  if (!connection) return null;
  const problem =
    backend.kind === "unavailable"
      ? serveProblemShort(
          t,
          backend.problem ?? { reason: "not-answering" },
          endpointHost(connection.endpoint),
        )
      : null;
  const readOnly =
    backend.kind === "protocol" &&
    backend.source === "local" &&
    backend.describe.readOnly;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
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
      {readOnly && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              data-testid="deco-serve-read-only"
              className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-foreground"
            >
              {t("decoServe.chip.readOnly")}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <RichCode text={t("decoServe.chip.readOnlyTooltip")} />
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** The connect flow's centered column; `fullScreen` outside the app shell. */
export function ConnectCentered({
  children,
  fullScreen = false,
}: {
  children: ReactNode;
  fullScreen?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center p-6",
        fullScreen ? "min-h-screen bg-background" : "h-full",
      )}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        {children}
      </div>
    </div>
  );
}
