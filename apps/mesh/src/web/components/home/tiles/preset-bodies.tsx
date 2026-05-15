/**
 * Per-preset tile body modules. The frame in `PresetTile` is generic;
 * everything visually preset-specific lives here, keyed by `presetId`.
 *
 * A body is a small React component that takes `(status, state)` and
 * decides what to render. Status drives the running/completed/error
 * branches; state carries per-preset structured data once the
 * workflow starts writing it. Until then, the "completed" branch shows
 * a designer's stub — visually informative, semantically a stand-in.
 *
 * Adding a new preset: drop a body in this file and register it in
 * `PRESET_BODIES`. No tile-type bump, no registry edit, no extra
 * component file.
 */

import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import type {
  PresetTaskState,
  PresetTaskStatus,
} from "@/web/layouts/tasks-panel/use-preset-tasks";

export interface PresetBodyProps {
  status: PresetTaskStatus | undefined;
  state: PresetTaskState | undefined;
}

export type PresetBody = (props: PresetBodyProps) => React.ReactNode;

export function RunningBody() {
  return (
    <div className="flex h-full flex-col gap-2 pt-1">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

function ErrorBody({ message }: { message: string | undefined }) {
  return (
    <div className="flex h-full items-center text-xs text-destructive">
      {message ?? "Something went wrong"}
    </div>
  );
}

function withStatus(
  status: PresetTaskStatus | undefined,
  state: PresetTaskState | undefined,
  completed: () => React.ReactNode,
) {
  if (status === "started" || status === "running") return <RunningBody />;
  if (status === "error") return <ErrorBody message={state?.error} />;
  return completed();
}

/* ---------- brand-context ---------- */

const BRAND_PALETTE = [
  { hex: "#0F172A" },
  { hex: "#22D3EE" },
  { hex: "#F4F4F5" },
  { hex: "#A1A1AA" },
];

const BrandContextBody: PresetBody = ({ status, state }) =>
  withStatus(status, state, () => (
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
  ));

/* ---------- landing-page ---------- */

const LandingPageBody: PresetBody = ({ status, state }) =>
  withStatus(status, state, () => (
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
  ));

/* ---------- error-monitoring ---------- */

const ErrorMonitoringBody: PresetBody = ({ status, state }) =>
  withStatus(status, state, () => (
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
  ));

/* ---------- registry ---------- */

const PRESET_BODIES: Record<string, PresetBody> = {
  "brand-context": BrandContextBody,
  "landing-page": LandingPageBody,
  "error-monitoring": ErrorMonitoringBody,
};

export function getPresetBody(presetId: string): PresetBody | null {
  return PRESET_BODIES[presetId] ?? null;
}
