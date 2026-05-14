/**
 * Tile renderers. One per preset task. Mock content for now — the agents
 * that drive these don't produce real outputs yet, so each tile shows a
 * representative preview while the work is "running" or "ready".
 */

import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Activity, Globe02, Stars01 } from "@untitledui/icons";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { TileState } from "./types";

const BRAND_PALETTE = [
  { hex: "#0F172A", label: "Primary" },
  { hex: "#22D3EE", label: "Accent" },
  { hex: "#F4F4F5", label: "Surface" },
  { hex: "#A1A1AA", label: "Muted" },
];

function TileShell({
  title,
  subtitle,
  icon,
  taskId,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  taskId: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <button
      type="button"
      onClick={() =>
        navigate({
          to: "/$org/$taskId",
          params: { org: org.slug, taskId },
        })
      }
      className={cn(
        "group/tile relative flex h-full w-full flex-col gap-4 rounded-2xl border border-border bg-background p-5 text-left",
        "transition-all hover:border-border hover:shadow-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-foreground/5 text-foreground/70">
          {icon}
        </span>
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
    <div className="flex h-full flex-col gap-2">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

export function BrandContextTile({ state }: { state: TileState }) {
  const subtitle =
    state.status === "running" ? "Pulling site assets…" : "Brand snapshot";
  return (
    <TileShell
      title="Brand context"
      subtitle={subtitle}
      icon={<Stars01 size={14} />}
      taskId={state.taskId}
    >
      {state.status === "running" ? (
        <RunningBody />
      ) : (
        <div className="flex flex-wrap gap-2">
          {BRAND_PALETTE.map((swatch) => (
            <div
              key={swatch.hex}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5"
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
    </TileShell>
  );
}

export function LandingPageTile({ state }: { state: TileState }) {
  const subtitle =
    state.status === "running" ? "Drafting sections…" : "Page preview";
  return (
    <TileShell
      title="Landing page"
      subtitle={subtitle}
      icon={<Globe02 size={14} />}
      taskId={state.taskId}
    >
      {state.status === "running" ? (
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
    </TileShell>
  );
}

export function ErrorMonitoringTile({ state }: { state: TileState }) {
  const subtitle =
    state.status === "running" ? "Connecting your stack…" : "Live errors";
  return (
    <TileShell
      title="Error monitoring"
      subtitle={subtitle}
      icon={<Activity size={14} />}
      taskId={state.taskId}
    >
      {state.status === "running" ? (
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
    </TileShell>
  );
}
