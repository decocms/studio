/**
 * Plan and Monitor under the new navigation, before they exist: what each
 * will do, over a sketch of it. The sketch is decoration, so it carries no
 * copy of its own and is hidden from assistive tech.
 */

import type { ComponentType } from "react";
import { Navigate } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  CheckDone01,
  Target04,
  TrendUp01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import type { TranslationKey } from "@/i18n/use-t.ts";

type Kind = "plan" | "monitor";
type Icon = ComponentType<{ size?: number; className?: string }>;

const COPY: Record<
  Kind,
  {
    heading: TranslationKey;
    description: TranslationKey;
    points: { Icon: Icon; labelKey: TranslationKey; tone: string }[];
  }
> = {
  plan: {
    heading: "home.comingSoon.planHeading",
    description: "home.comingSoon.planDescription",
    points: [
      {
        Icon: Target04,
        labelKey: "home.comingSoon.planGoals",
        tone: "bg-chart-2/15 text-chart-2",
      },
      {
        Icon: CheckDone01,
        labelKey: "home.comingSoon.planTasks",
        tone: "bg-chart-1/15 text-chart-1",
      },
      {
        Icon: TrendUp01,
        labelKey: "home.comingSoon.planProgress",
        tone: "bg-chart-4/15 text-chart-4",
      },
    ],
  },
  monitor: {
    heading: "home.comingSoon.monitorHeading",
    description: "home.comingSoon.monitorDescription",
    points: [
      {
        Icon: Activity,
        labelKey: "home.comingSoon.monitorWatch",
        tone: "bg-chart-2/15 text-chart-2",
      },
      {
        Icon: AlertTriangle,
        labelKey: "home.comingSoon.monitorSignal",
        tone: "bg-chart-3/15 text-chart-3",
      },
      {
        Icon: CheckCircle,
        labelKey: "home.comingSoon.monitorVerdict",
        tone: "bg-chart-5/15 text-chart-5",
      },
    ],
  },
};

/** A line of text, sketched. */
function Line({ className }: { className: string }) {
  return <span className={cn("block h-2 rounded-full bg-muted", className)} />;
}

const GOALS = [
  { title: "w-32", fill: "w-[72%]", tone: "bg-chart-2", value: "72%" },
  { title: "w-24", fill: "w-[45%]", tone: "bg-chart-1", value: "45%" },
  { title: "w-28", fill: "w-[88%]", tone: "bg-chart-4", value: "88%" },
];

function PlanSketch() {
  return (
    <div className="flex flex-col gap-5">
      {GOALS.map((goal) => (
        <div key={goal.value} className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Target04 size={14} />
            </span>
            <Line className={goal.title} />
            <span className="ml-auto text-xs font-medium tabular-nums text-muted-foreground">
              {goal.value}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full", goal.fill, goal.tone)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A metric holding steady, then dropping through its floor. */
const SERIES =
  "M0 38 C20 34 34 40 52 33 S86 28 104 31 S138 26 156 29 S190 36 208 44 S236 66 260 62";

function MonitorSketch() {
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <svg
          viewBox="0 0 260 80"
          className="h-28 w-full overflow-visible text-chart-2"
          preserveAspectRatio="none"
        >
          <path
            d={`${SERIES} L260 80 L0 80 Z`}
            className="fill-current opacity-15"
          />
          <path
            d={SERIES}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={0}
            x2={260}
            y1={50}
            y2={50}
            className="stroke-destructive/50"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* Where the line crosses the floor: the signal. */}
        <span className="absolute top-[62.5%] left-[84.6%] flex size-3 -translate-1/2">
          <span className="absolute inline-flex size-full rounded-full bg-destructive/60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-3 rounded-full bg-destructive ring-2 ring-card" />
        </span>
      </div>
      <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
        {[
          { dot: "bg-destructive", line: "w-36" },
          { dot: "bg-chart-3", line: "w-28" },
        ].map((row) => (
          <div key={row.line} className="flex items-center gap-2.5">
            <span className={cn("size-2 shrink-0 rounded-full", row.dot)} />
            <Line className={row.line} />
            <Line className="ml-auto w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Sketch({ kind }: { kind: Kind }) {
  switch (kind) {
    case "plan":
      return <PlanSketch />;
    case "monitor":
      return <MonitorSketch />;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** Only the new navigation announces these, so anyone else lands on home. */
export function ComingSoonPage({ kind }: { kind: Kind }) {
  const t = useT();
  const { org } = useProjectContext();
  const projectFirstNav = useProjectFirstNav();
  const copy = COPY[kind];
  if (!projectFirstNav) {
    return <Navigate to="/$org/home" params={{ org: org.slug }} replace />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-10 px-4 pt-12 pb-16 md:pt-20">
        <div aria-hidden className="relative w-full max-w-md">
          <div className="absolute inset-x-10 -top-4 h-40 rounded-full bg-chart-2/20 blur-3xl" />
          <div className="relative rounded-2xl bg-card p-6 card-shadow [mask-image:linear-gradient(to_bottom,black_65%,transparent)]">
            <Sketch kind={kind} />
          </div>
        </div>
        <div className="flex flex-col items-center gap-3 text-center">
          <Badge variant="muted">{t("home.comingSoon.badge")}</Badge>
          <h1 className="text-2xl font-medium text-balance text-foreground">
            {t(copy.heading)}
          </h1>
          <p className="max-w-md text-sm text-pretty text-muted-foreground">
            {t(copy.description)}
          </p>
        </div>
        <ul className="grid w-full gap-3 sm:grid-cols-3">
          {copy.points.map(({ Icon, labelKey, tone }) => (
            <li
              key={labelKey}
              className="flex items-center gap-3 rounded-xl bg-card p-4 card-shadow sm:flex-col sm:items-start"
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  tone,
                )}
              >
                <Icon size={18} />
              </span>
              <span className="text-sm text-foreground">{t(labelKey)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
