import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";
import type { ToolDefinition } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import {
  AlertTriangle,
  Eye,
  Globe02,
  LayersTwo01,
  RefreshCw01,
} from "@untitledui/icons";

export interface Tool {
  name: string;
  description?: string;
  annotations?: ToolDefinition["annotations"];
  _meta?: Record<string, unknown>;
}

const ANNOTATION_HINTS = [
  {
    key: "readOnlyHint",
    labelKey: "tools.toolsList.readOnly" as const,
    Icon: Eye,
    variant: "secondary",
  },
  {
    key: "destructiveHint",
    labelKey: "tools.toolsList.destructive" as const,
    Icon: AlertTriangle,
    variant: "destructive",
  },
  {
    key: "idempotentHint",
    labelKey: "tools.toolsList.idempotent" as const,
    Icon: RefreshCw01,
    variant: "secondary",
  },
  {
    key: "openWorldHint",
    labelKey: "tools.toolsList.openWorld" as const,
    Icon: Globe02,
    variant: "outline",
  },
] as const;

export function ToolAnnotationBadges({
  annotations,
  _meta,
}: {
  annotations?: ToolDefinition["annotations"];
  _meta?: Record<string, unknown>;
}) {
  const t = useT();
  const hasUI = !!getUIResourceUri(_meta);
  const active = annotations
    ? ANNOTATION_HINTS.filter((h) => annotations[h.key] === true)
    : [];
  if (active.length === 0 && !hasUI) return null;
  return (
    <TooltipProvider>
      <div className="flex gap-1 flex-nowrap">
        {hasUI && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge asChild variant="secondary" className="size-6 p-1">
                <LayersTwo01 />
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t("tools.toolsList.interactive")}</TooltipContent>
          </Tooltip>
        )}
        {active.map(({ labelKey, Icon, variant }) => (
          <Tooltip key={labelKey}>
            <TooltipTrigger asChild>
              <Badge asChild variant={variant} className="size-6 p-1">
                <Icon />
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t(labelKey)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
