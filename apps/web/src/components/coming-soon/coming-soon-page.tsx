/**
 * Plan under the new navigation, before it exists: what it will do, over a
 * sketch of it. The sketch is decoration, so it carries no copy of its own
 * and is hidden from assistive tech.
 */

import type { ComponentType } from "react";
import { Navigate } from "@tanstack/react-router";
import { CheckDone01, Target04, TrendUp01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Page } from "@/components/page";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import type { TranslationKey } from "@/i18n/use-t.ts";

type Kind = "plan";
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

/** Only the new navigation announces it, so anyone else lands on home. */
export function ComingSoonPage({ kind }: { kind: Kind }) {
  const t = useT();
  const { org } = useProjectContext();
  const projectFirstNav = useProjectFirstNav();
  const copy = COPY[kind];
  if (!projectFirstNav) {
    return <Navigate to="/$org/home" params={{ org: org.slug }} replace />;
  }
  return (
    <Page>
      <Page.Content>
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-10 px-4 pt-12 pb-16 md:pt-20">
          <div aria-hidden className="relative w-full max-w-md">
            <div className="absolute inset-x-10 -top-4 h-40 rounded-full bg-chart-2/20 blur-3xl" />
            <div className="relative surface p-6 [mask-image:linear-gradient(to_bottom,black_65%,transparent)]">
              <PlanSketch />
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
                className="flex items-center gap-3 surface p-4 sm:flex-col sm:items-start"
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
      </Page.Content>
    </Page>
  );
}
