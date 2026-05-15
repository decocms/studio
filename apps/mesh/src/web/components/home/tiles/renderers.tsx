/**
 * Tile renderers. One per preset task. Until each preset agent produces
 * real output, the tiles render a representative preview based on the
 * tile's lifecycle status (running while the chat is being worked on,
 * "ready" otherwise).
 */

import { useNavigate } from "@tanstack/react-router";
import {
  useProjectContext,
  WELL_KNOWN_AGENT_TEMPLATES,
} from "@decocms/mesh-sdk";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { IntegrationIcon } from "@/web/components/integration-icon";
import type { TileRenderProps } from "./types";

/**
 * Pulls the registered template icon for a preset tile. These templates
 * are stubs today — the dev wires the actual agent behaviour later, but
 * the tile already renders the agent's eventual visual identity.
 */
function templateIcon(templateId: string): { icon: string; title: string } {
  const tpl = WELL_KNOWN_AGENT_TEMPLATES.find((t) => t.id === templateId);
  return { icon: tpl?.icon ?? "", title: tpl?.title ?? "" };
}

type Status = "running" | "ready";

function readStatus(config: Record<string, unknown> | undefined): Status {
  return config?.status === "ready" ? "ready" : "running";
}

function readTaskId(
  config: Record<string, unknown> | undefined,
): string | null {
  const v = config?.taskId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function TileFrame({
  templateId,
  title,
  subtitle,
  taskId,
  isEditMode,
  children,
}: {
  templateId: string;
  title: string;
  subtitle: string;
  taskId: string | null;
  isEditMode: boolean;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const interactive = !isEditMode && taskId;
  const { icon: iconStr, title: tplName } = templateIcon(templateId);
  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={
        interactive
          ? () =>
              navigate({
                to: "/$org/$taskId",
                params: { org: org.slug, taskId },
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
          <div className="truncate text-sm font-medium text-foreground">
            {title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {subtitle}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </button>
  );
}

function RunningBody() {
  return (
    <div className="flex h-full flex-col gap-2 pt-1">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

const BRAND_PALETTE = [
  { hex: "#0F172A" },
  { hex: "#22D3EE" },
  { hex: "#F4F4F5" },
  { hex: "#A1A1AA" },
];

export function BrandContextTile({ instance, isEditMode }: TileRenderProps) {
  const status = readStatus(instance.config);
  const subtitle =
    status === "running" ? "Pulling site assets…" : "Brand snapshot";
  return (
    <TileFrame
      templateId="brand-context"
      title="Brand context"
      subtitle={subtitle}
      taskId={readTaskId(instance.config)}
      isEditMode={isEditMode}
    >
      {status === "running" ? (
        <RunningBody />
      ) : (
        <div className="flex flex-wrap gap-2">
          {BRAND_PALETTE.map((swatch) => (
            <div
              key={swatch.hex}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5"
            >
              <span
                className="size-3.5 rounded-sm border border-border/60"
                style={{ backgroundColor: swatch.hex }}
                aria-hidden
              />
              <span className="text-[11px] font-medium text-muted-foreground">
                {swatch.hex}
              </span>
            </div>
          ))}
        </div>
      )}
    </TileFrame>
  );
}

export function LandingPageTile({ instance, isEditMode }: TileRenderProps) {
  const status = readStatus(instance.config);
  const subtitle = status === "running" ? "Drafting sections…" : "Page preview";
  return (
    <TileFrame
      templateId="landing-page"
      title="Landing page"
      subtitle={subtitle}
      taskId={readTaskId(instance.config)}
      isEditMode={isEditMode}
    >
      {status === "running" ? (
        <RunningBody />
      ) : (
        <div className="flex h-full flex-col justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="space-y-1.5">
            <div className="h-2 w-1/2 rounded-sm bg-foreground/20" />
            <div className="h-2 w-3/4 rounded-sm bg-foreground/10" />
            <div className="h-2 w-2/3 rounded-sm bg-foreground/10" />
          </div>
          <div className="flex gap-1.5">
            <div className="h-6 w-16 rounded-md bg-primary/80" />
            <div className="h-6 w-12 rounded-md border border-border" />
          </div>
        </div>
      )}
    </TileFrame>
  );
}

export function ErrorMonitoringTile({ instance, isEditMode }: TileRenderProps) {
  const status = readStatus(instance.config);
  const subtitle =
    status === "running" ? "Connecting your stack…" : "Live errors";
  return (
    <TileFrame
      templateId="system-health"
      title="System health"
      subtitle={subtitle}
      taskId={readTaskId(instance.config)}
      isEditMode={isEditMode}
    >
      {status === "running" ? (
        <RunningBody />
      ) : (
        <div className="flex h-full flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              0
            </span>
            <span className="text-[11px] text-muted-foreground">last 24h</span>
          </div>
          <svg
            viewBox="0 0 120 32"
            className="h-8 w-full text-emerald-500"
            aria-hidden
          >
            <polyline
              points="0,24 16,18 32,22 48,12 64,16 80,8 96,14 120,10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </div>
      )}
    </TileFrame>
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
