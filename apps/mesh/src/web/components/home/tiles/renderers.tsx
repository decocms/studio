/**
 * Tile renderer — one generic `PresetTile` that frames whatever preset
 * the tile is bound to. The frame (icon, title, subtitle, Done pill,
 * click→thread) is fully data-driven from the preset's `usePresetTasks`
 * entry. The body inside the frame is delegated to a per-preset module
 * in `preset-bodies.tsx` keyed by `presetId`. A new preset only needs a
 * BE definition + (optionally) a body module — no registry entry, no
 * tile-type enum bump.
 */

import { useNavigate } from "@tanstack/react-router";
import {
  useProjectContext,
  WELL_KNOWN_AGENT_TEMPLATES,
} from "@decocms/mesh-sdk";
import { Check } from "@untitledui/icons";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { IntegrationIcon } from "@/web/components/integration-icon";
import type { PresetTaskStatus } from "@decocms/mesh-sdk";
import { usePresetTasks } from "@/web/layouts/tasks-panel/use-preset-tasks";
import { getPresetBody, RunningBody } from "./preset-bodies";
import type { TileRenderProps } from "./types";

/**
 * Pulls the registered template icon for a preset tile. The mapping is
 * by preset id today — the well-known templates were named to match.
 */
function templateIcon(templateId: string): { icon: string; title: string } {
  const tpl = WELL_KNOWN_AGENT_TEMPLATES.find((t) => t.id === templateId);
  return { icon: tpl?.icon ?? "", title: tpl?.title ?? "" };
}

function readPresetId(
  config: Record<string, unknown> | undefined,
): string | null {
  const stored = config?.presetId;
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

function readTaskId(
  config: Record<string, unknown> | undefined,
): string | null {
  const v = config?.taskId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readVirtualMcpId(
  config: Record<string, unknown> | undefined,
): string | null {
  const v = config?.virtualMcpId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function statusSubtitle(status: PresetTaskStatus | undefined): string {
  switch (status) {
    case "started":
    case "running":
      return "Working…";
    case "completed":
      return "Done";
    case "error":
      return "Errored";
    default:
      return "Ready";
  }
}

export function PresetTile({ instance, isEditMode }: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { tasks: presetTasks } = usePresetTasks(org.slug);

  const presetId = readPresetId(instance.config);
  const taskId = readTaskId(instance.config);
  const virtualMcpId = readVirtualMcpId(instance.config);
  const preset = presetId
    ? presetTasks.find((t) => t.id === presetId)
    : undefined;
  const status = preset?.state?.status;
  const isCompleted = status === "completed";
  const title = preset?.display.title ?? "Preset";
  const subtitle = statusSubtitle(status);

  const { icon: iconStr, title: tplName } = templateIcon(presetId ?? "");
  const interactive = !isEditMode && Boolean(taskId);

  const Body = presetId ? getPresetBody(presetId) : null;

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={
        interactive && taskId
          ? () =>
              navigate({
                to: "/$org/$taskId",
                params: { org: org.slug, taskId },
                search: virtualMcpId ? { virtualmcpid: virtualMcpId } : {},
              })
          : undefined
      }
      className={cn(
        "group/tile flex h-full w-full flex-col gap-3 p-5 text-left bg-card",
        interactive && "cursor-pointer hover:bg-card/80 transition-colors",
        !interactive && "cursor-default",
      )}
    >
      <div className="flex items-center gap-2.5">
        <IntegrationIcon icon={iconStr} name={tplName || title} size="xs" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-sm font-medium text-foreground">
              {title}
            </div>
            {isCompleted && (
              <span
                className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                aria-label="Completed"
              >
                <Check size={12} />
                Done
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {subtitle}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {Body ? (
          <Body status={status} state={preset?.state} />
        ) : (
          <RunningBody />
        )}
      </div>
    </button>
  );
}

export function TileSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-5">
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}
