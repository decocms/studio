import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import type { ToolDefinition } from "@decocms/studio-sdk";
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
  { key: "readOnlyHint", label: "Read-only", Icon: Eye, variant: "secondary" },
  {
    key: "destructiveHint",
    label: "Destructive",
    Icon: AlertTriangle,
    variant: "destructive",
  },
  {
    key: "idempotentHint",
    label: "Idempotent",
    Icon: RefreshCw01,
    variant: "secondary",
  },
  {
    key: "openWorldHint",
    label: "Open-world",
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
            <TooltipContent>Interactive</TooltipContent>
          </Tooltip>
        )}
        {active.map(({ label, Icon, variant }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Badge asChild variant={variant} className="size-6 p-1">
                <Icon />
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
