/**
 * A tab with nothing to show yet, the same on every tab: the tab itself, from
 * the preview, faded far back and held to the screen's height (nothing to
 * scroll through), and one card in the middle listing the sources that tab
 * reads, each with what it brings and its button, the one to start with
 * first. Metrics reads several, so its card has several lines; the others
 * read one. Once a tab has data, a metric card still missing its source
 * keeps a small button of its own.
 */

import { type ReactNode, useState } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Globe02, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Check } from "@untitledui/icons";
import { ListRow } from "@decocms/ui/components/list-row.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { IntegrationIcon } from "@/components/integration-icon";
import { useProjectContext } from "@/sdk";
import { formatCount } from "@/layouts/main-panel-tabs/monitor-v8";
import type { TimelinePoint } from "@/layouts/main-panel-tabs/cdn-tab";
import { CopyButton } from "@/layouts/main-panel-tabs/analytics-tab";
import { useT } from "@/i18n/use-t.ts";
import { openNewProjectDialog } from "@/components/projects/new-project-store";
import { ConnectSourceDialog } from "@/routes/reports-onboarding/connect-source-dialog";
import { VtexConnectButton } from "./vtex-connect-dialog";
import type { ExperimentRow, SourceId, SourceState } from "./board";
import { connectPowers, platformName } from "./sources-panel";
import {
  type SiteUsage,
  SitesMonitor,
  type SitesMonitorData,
  sumSummaries,
  sumTimelines,
} from "./sites-monitor";
import { useSourceIcons } from "./use-source-icons";

/** How far back the preview sits behind the button. */
export const FADED =
  "pointer-events-none flex flex-col gap-4 opacity-15 grayscale select-none";

/**
 * The sources the org connects in place, in the same dialog the reports app
 * uses (OAuth or credentials, then the app's own settings), by its field.
 * A site opens the New project dialog; the rest go to where they are set up.
 */
const CONNECT_FIELD: Partial<Record<SourceId, string>> = {
  deploys: "github",
  analytics: "ga4",
  search: "gsc",
};

/** The button over a faded tab or card: the source, by name. */
export function ConnectButton({
  label,
  link,
  source,
  quiet = false,
}: {
  label: string;
  /** Where to go when the source can't be connected in place. */
  link: LinkProps;
  source?: SourceId;
  /** An outline button, for a source that isn't the one to start with. */
  quiet?: boolean;
}) {
  const look = quiet
    ? ({ variant: "outline", className: "gap-1" } as const)
    : ({ className: "gap-1 shadow-sm" } as const);
  const [open, setOpen] = useState(false);
  const field = source ? CONNECT_FIELD[source] : undefined;
  // A site is a project: connecting one is creating it, in the app's own
  // New project dialog (import a repository or start a site).
  if (source === "site") {
    return (
      <Button
        size="sm"
        {...look}
        onClick={() => openNewProjectDialog("monitor")}
      >
        <Plus size={14} />
        {label}
      </Button>
    );
  }
  // Orders come from the order ingest, not the VTEX connection alone.
  if (source === "orders") {
    return <VtexConnectButton label={label} {...look} />;
  }
  if (!field) {
    return (
      <Button asChild size="sm" {...look}>
        <Link {...link}>
          <Plus size={14} />
          {label}
        </Link>
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" {...look} onClick={() => setOpen(true)}>
        <Plus size={14} />
        {label}
      </Button>
      {open && (
        <ConnectSourceDialog field={field} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** Which tab a panel stands in for, so its picture can show that tab. */
export type LockedKind = "metrics" | "deploys" | "experiments" | "analytics";

/**
 * What each tab shows once connected, drawn small (160×72) in the chart
 * colours the tab itself uses: the picture at the top of its panel.
 */
function Vignette({ kind }: { kind: LockedKind }) {
  switch (kind) {
    case "metrics":
      return (
        <>
          <defs>
            <linearGradient id="vig-metrics" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <line x1={4} x2={156} y1={66} y2={66} className="stroke-border" />
          <path
            d="M4 58 C26 57 38 50 54 38 S80 18 98 24"
            fill="none"
            className="stroke-muted-foreground/35"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <path
            d="M4 60 C26 59 38 53 54 42 S80 26 98 32 L98 66 L4 66 Z"
            fill="url(#vig-metrics)"
          />
          <path
            d="M4 60 C26 59 38 53 54 42 S80 26 98 32"
            fill="none"
            className="stroke-chart-1"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <path
            d="M98 32 C116 38 128 22 156 14"
            fill="none"
            className="stroke-chart-1/55"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray="1 6"
          />
          <circle cx={98} cy={32} r={9} className="fill-chart-1/15" />
          <circle
            cx={98}
            cy={32}
            r={4}
            className="fill-chart-1 stroke-background"
            strokeWidth={2}
          />
        </>
      );
    case "deploys":
      return (
        <>
          <line x1={4} x2={156} y1={66} y2={66} className="stroke-border" />
          <path
            d="M4 50 C22 48 30 40 44 40 S70 44 80 42 S96 60 110 58 S140 46 156 44"
            fill="none"
            className="stroke-chart-1"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {[
            { x: 40, tone: "success" },
            { x: 82, tone: "destructive" },
            { x: 128, tone: "muted" },
          ].map(({ x, tone }) => (
            <g key={x}>
              <line
                x1={x}
                x2={x}
                y1={20}
                y2={66}
                strokeDasharray="2 3"
                className={cn(
                  tone === "destructive"
                    ? "stroke-destructive/50"
                    : "stroke-muted-foreground/30",
                )}
              />
              <circle
                cx={x}
                cy={12}
                r={6}
                strokeWidth={2.5}
                className={cn(
                  "stroke-background",
                  tone === "success" && "fill-success",
                  tone === "destructive" && "fill-destructive",
                  tone === "muted" && "fill-muted-foreground/50",
                )}
              />
            </g>
          ))}
        </>
      );
    case "experiments":
      // A page split down the middle: version A as it is, version B with the
      // change, and B winning.
      return (
        <>
          <rect
            x={20}
            y={4}
            width={120}
            height={64}
            rx={8}
            strokeWidth={1.5}
            className="fill-background stroke-border"
          />
          <line x1={20} x2={140} y1={16} y2={16} className="stroke-border" />
          {[28, 34, 40].map((cx) => (
            <circle
              key={cx}
              cx={cx}
              cy={10}
              r={1.6}
              className="fill-muted-foreground/40"
            />
          ))}
          <line
            x1={80}
            x2={80}
            y1={16}
            y2={68}
            strokeDasharray="2 3"
            className="stroke-muted-foreground/40"
          />
          {/* A */}
          <rect
            x={28}
            y={24}
            width={44}
            height={14}
            rx={3}
            className="fill-muted-foreground/15"
          />
          <rect
            x={28}
            y={43}
            width={34}
            height={4}
            rx={2}
            className="fill-muted-foreground/20"
          />
          <rect
            x={28}
            y={51}
            width={26}
            height={4}
            rx={2}
            className="fill-muted-foreground/20"
          />
          <rect
            x={28}
            y={59}
            width={16}
            height={5}
            rx={2.5}
            className="fill-muted-foreground/30"
          />
          {/* B */}
          <rect
            x={88}
            y={24}
            width={44}
            height={14}
            rx={3}
            className="fill-chart-1/25"
          />
          <rect
            x={88}
            y={43}
            width={34}
            height={4}
            rx={2}
            className="fill-muted-foreground/20"
          />
          <rect
            x={88}
            y={51}
            width={26}
            height={4}
            rx={2}
            className="fill-muted-foreground/20"
          />
          <rect
            x={88}
            y={58}
            width={26}
            height={7}
            rx={3.5}
            className="fill-chart-1"
          />
          <circle
            cx={140}
            cy={6}
            r={8}
            strokeWidth={2.5}
            className="fill-success stroke-background"
          />
          <path
            d="M136.5 6 l2.5 2.5 l4.5 -4.5"
            fill="none"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-background"
          />
        </>
      );
    case "analytics":
      return (
        <>
          <defs>
            <linearGradient id="vig-analytics" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path
            d="M4 34 C24 24 36 12 56 18 S88 38 108 22 S144 10 156 16 L156 44 L4 44 Z"
            fill="url(#vig-analytics)"
          />
          <path
            d="M4 34 C24 24 36 12 56 18 S88 38 108 22 S144 10 156 16"
            fill="none"
            className="stroke-chart-1"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {[112, 80, 48].map((w, row) => (
            <rect
              key={w}
              x={80 - w / 2}
              y={50 + row * 7}
              width={w}
              height={4}
              rx={2}
              className={cn(
                row === 0 && "fill-chart-1/60",
                row === 1 && "fill-chart-1/40",
                row === 2 && "fill-chart-1/25",
              )}
            />
          ))}
        </>
      );
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** The panel's picture: what the tab shows once its sources are in. */
function ConnectGlyph({ kind }: { kind: LockedKind }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 160 72"
      className="h-[4.5rem] w-40 self-center overflow-visible"
    >
      <Vignette kind={kind} />
    </svg>
  );
}

/** One source in the card: connected, or the button that connects it. */
export interface SourceStep {
  source: SourceId;
  state: SourceState;
  /** For a step that isn't connecting (a first experiment). */
  label?: string;
  /** What the source brings to this tab, when it isn't what it brings to Metrics. */
  meta?: string;
  link?: LinkProps;
}

const NO_STEPS: readonly SourceStep[] = [];

export function Locked({
  kind,
  title,
  steps = NO_STEPS,
  guide,
  link,
  children,
}: {
  kind: LockedKind;
  title: string;
  /** In the order to take them; the first not connected leads. */
  steps?: readonly SourceStep[];
  /** In place of the steps, for a tab you set up rather than connect. */
  guide?: ReactNode;
  /** Where a source goes when it can't be connected in place. */
  link: LinkProps;
  /** The tab as it will look, from the preview. */
  children: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const iconOf = useSourceIcons(org.slug, []);
  // A VTEX connection without the order ingest still needs connecting here.
  const lead = steps.find((s) => s.state !== "live");
  return (
    <div className="relative h-[calc(100dvh-11rem)] min-h-[520px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
      <div aria-hidden className={FADED}>
        {children}
      </div>
      {/* The design system's floating panel, frosted glass. No scrim: the
          page under it is already faded, and a scrim boxed to the content
          reads as a grey slab rather than a dimmed screen. */}
      <div className="absolute inset-0 flex items-center justify-center pb-16">
        <div className="glass flex w-full max-w-md flex-col gap-5 rounded-2xl p-6">
          <ConnectGlyph kind={kind} />
          <div className="flex flex-col gap-1">
            <p className="text-[1.375rem] leading-tight font-medium tracking-[-0.02em] text-foreground">
              {title}
            </p>
          </div>
          {guide}
          <div className="flex flex-col">
            {steps.map((step) => (
              <ListRow
                key={step.source + (step.label ?? "")}
                variant="divided"
                lead={
                  <IntegrationIcon
                    icon={iconOf(step.source)}
                    name={platformName(step.source, t)}
                    size="xs"
                    fit="contain"
                  />
                }
                title={platformName(step.source, t)}
                meta={step.meta ?? connectPowers(step.source, t)}
                trailing={
                  step.state !== "live" ? (
                    <ConnectButton
                      label={step.label ?? t("monitor.connect.short")}
                      link={step.link ?? link}
                      source={step.link ? undefined : step.source}
                      quiet={step !== lead}
                    />
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Check size={14} className="text-success" />
                      {t("monitor.connect.done")}
                    </span>
                  )
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The collector's tag, as a site off our CDN pastes it. */
const SNIPPET =
  '<script async src="https://analytics.decocdn.com/_dq/a.js?k=YOUR_TOKEN"></script>';

/**
 * How analytics gets onto a site, for the Analytics panel: there is nothing
 * to connect. A site on deco collects once it's turned on; any other site
 * pastes one line, with the token its project gives it.
 */
export function AnalyticsGuide() {
  const t = useT();
  const { org } = useProjectContext();
  const iconOf = useSourceIcons(org.slug, []);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col">
        <ListRow
          variant="divided"
          lead={
            <IntegrationIcon
              icon={iconOf("site")}
              name={platformName("site", t)}
              size="xs"
              fit="contain"
            />
          }
          title={t("monitor.analyticsGuide.deco")}
          meta={t("monitor.analyticsGuide.decoHow")}
        />
        <ListRow
          variant="divided"
          lead={
            <span className="flex size-6 items-center justify-center text-muted-foreground">
              <Globe02 size={16} />
            </span>
          }
          title={t("monitor.analyticsGuide.other")}
          meta={t("monitor.analyticsGuide.otherHow")}
        />
      </div>
      <div className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/30 py-1.5 pr-1.5 pl-3">
        <code className="pt-1 text-xs break-all text-muted-foreground">
          {SNIPPET}
        </code>
        <CopyButton text={SNIPPET} />
      </div>
      <Button
        size="sm"
        className="gap-1 self-center shadow-sm"
        onClick={() => openNewProjectDialog("monitor")}
      >
        <Plus size={14} />
        {t("monitor.analyticsGuide.add")}
      </Button>
    </div>
  );
}

const LINE = "flex h-10 items-center gap-3 rounded-lg px-2 text-sm";
const CARD = "surface flex flex-col gap-2 p-3";

const STATE_DOT: Record<ExperimentRow["state"], string> = {
  ready: "bg-success",
  running: "bg-chart-1",
  "low-traffic": "bg-muted-foreground",
};

/** The org's experiments list, from the preview, for the faded background. */
export function ExperimentsPreview({
  experiments,
}: {
  experiments: readonly ExperimentRow[];
}) {
  const t = useT();
  return (
    <section className={CARD}>
      <h2 className="flex items-center gap-2 px-2 pt-1 pb-1 text-sm font-medium text-foreground">
        {t("monitor.view.experiments")}
        <span className="text-muted-foreground tabular-nums">
          {experiments.length}
        </span>
      </h2>
      {experiments.map((e) => (
        <div key={e.id} className={LINE}>
          <span className={cn("size-1.5 rounded-full", STATE_DOT[e.state])} />
          <span className="text-foreground">{e.title}</span>
          <span className="flex-1 text-muted-foreground">
            {formatCount(e.participants)} · {Math.round(e.probability * 100)}%
          </span>
        </div>
      ))}
    </section>
  );
}

/** A week of gently rising traffic, made up for the faded background. */
function previewTimeline(scale: number, lift: number): TimelinePoint[] {
  return Array.from({ length: 7 }, (_, i) => {
    const requests = Math.round(
      scale * (1 + lift * i + (i % 2) * 0.05 + (i === 5 ? 0.12 : 0)),
    );
    return {
      bucket: `2026-01-0${i + 1}`,
      requests,
      pageviews: Math.round(requests / 26),
      bandwidth_bytes: requests * 28_000,
      cache_hit_ratio: 0.84 + i * 0.006,
    };
  });
}

function previewSite(
  name: string,
  scale: number,
  lift: number,
): SiteUsage & {
  timeline: TimelinePoint[];
  previousTimeline: TimelinePoint[];
} {
  const timeline = previewTimeline(scale, lift);
  const previousTimeline = previewTimeline(scale * 0.9, lift / 2);
  const summary = (points: TimelinePoint[]) =>
    sumSummaries(
      points.map((p) => ({
        total_requests: p.requests,
        total_bandwidth_bytes: p.bandwidth_bytes,
        cache_hit_ratio: p.cache_hit_ratio,
        avg_latency_ms: 42,
        status_2xx_count: p.requests,
        status_4xx_count: 0,
        status_5xx_count: 0,
        unique_countries: 12,
        pageviews: p.pageviews,
      })),
    );
  return {
    id: name,
    name,
    summary: summary(timeline),
    previous: summary(previousTimeline),
    series: timeline.map((p) => p.pageviews),
    previousSeries: previousTimeline.map((p) => p.pageviews),
    timeline,
    previousTimeline,
  };
}

const PREVIEW_SITES = [
  previewSite("Site", 690_000, 0.04),
  previewSite("App", 245_000, 0.02),
  previewSite("Blog", 60_000, 0.01),
];

const PREVIEW_ANALYTICS: SitesMonitorData = {
  summary: sumSummaries(PREVIEW_SITES.map((s) => s.summary)),
  previous: sumSummaries(
    PREVIEW_SITES.flatMap((s) => (s.previous ? [s.previous] : [])),
  ),
  timeline: sumTimelines(PREVIEW_SITES.map((s) => s.timeline)),
  previousTimeline: sumTimelines(PREVIEW_SITES.map((s) => s.previousTimeline)),
  sites: PREVIEW_SITES,
};

export function AnalyticsPreview() {
  return <SitesMonitor data={PREVIEW_ANALYTICS} />;
}
