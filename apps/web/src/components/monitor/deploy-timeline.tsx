/**
 * The deploys themselves, two weeks of them: one lane per project, each
 * deploy a dot at the moment it shipped, coloured by what it did, a rollout
 * a diamond. A cluster of red on one lane is the story the counts hid.
 * Hover a dot for what shipped, who shipped it and when.
 */

import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import type { Deploy, DeployVerdict } from "./board";
import { verdictName } from "./parts";

const DAY_MS = 86_400_000;
const DAYS = 14;

const VERDICTS: readonly DeployVerdict[] = [
  "improvement",
  "neutral",
  "regression",
  "settling",
  "unmeasured",
];

const DOT: Record<DeployVerdict, string> = {
  improvement: "bg-success",
  neutral: "bg-chart-1",
  regression: "bg-destructive",
  settling: "bg-muted-foreground",
  unmeasured: "bg-muted-foreground/40",
};

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function Tip({
  deploy,
  showProject,
}: {
  deploy: Deploy;
  showProject: boolean;
}) {
  const t = useT();
  const when = new Date(deploy.at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="flex max-w-72 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">
        {deploy.kind === "rollout"
          ? t("monitor.chart.rollout")
          : t("monitor.chart.deploy")}{" "}
        · {when}
      </span>
      <span className="text-sm font-medium">{deploy.message}</span>
      <span className="text-xs text-muted-foreground">
        {deploy.author}
        {showProject && ` · ${deploy.projectTitle}`} ·{" "}
        {verdictName(deploy.verdict, t)}
      </span>
    </div>
  );
}

export function DeployTimeline({
  deploys,
  showProject,
}: {
  deploys: readonly Deploy[];
  /** One lane per project at org scope; a single lane inside one. */
  showProject: boolean;
}) {
  const t = useT();
  // The window ends at first render; a re-render must not slide it.
  const [end] = useState(() => Date.now());
  const start = startOfDay(end) - (DAYS - 1) * DAY_MS;
  const span = end - start;
  const x = (ms: number) => `${((ms - start) / span) * 100}%`;
  const inRange = deploys.filter((d) => Date.parse(d.at) >= start);
  const lanes = showProject
    ? [...new Set(inRange.map((d) => d.projectTitle))]
    : [""];
  const days = Array.from({ length: DAYS }, (_, i) => start + i * DAY_MS);
  const regressions = inRange.filter((d) => d.verdict === "regression").length;
  const pct = inRange.length
    ? `${Math.round((100 * regressions) / inRange.length)}%`
    : "0%";

  const grid = (
    <>
      {days.map((day) => {
        const weekend = [0, 6].includes(new Date(day).getDay());
        return (
          <span
            key={day}
            aria-hidden
            className={cn(
              "absolute inset-y-0 border-l border-dashed border-border/60",
              weekend && "bg-muted/40",
            )}
            style={{ left: x(day), width: `${(DAY_MS / span) * 100}%` }}
          />
        );
      })}
    </>
  );

  return (
    <MetricCard
      title={t("monitor.deploys.history")}
      value={inRange.length}
      caption={
        <span className="text-meta">
          {t("monitor.deploys.historyCaption", { count: regressions, pct })}
        </span>
      }
      aside={
        <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1">
          {VERDICTS.map((v) => (
            <li key={v} className="text-meta flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", DOT[v])} />
              {verdictName(v, t)}
            </li>
          ))}
          <li className="text-meta flex items-center gap-1.5">
            <span className="size-2 rotate-45 rounded-[1px] bg-foreground" />
            {t("monitor.chart.rollout")}
          </li>
        </ul>
      }
    >
      <div className="flex flex-col">
        {lanes.map((lane) => (
          <div
            key={lane}
            className="flex h-10 items-center gap-3 border-b border-border/50"
          >
            {showProject && (
              <span className="w-32 shrink-0 truncate text-sm text-muted-foreground">
                {lane}
              </span>
            )}
            <div className="relative h-full flex-1">
              {grid}
              {inRange
                .filter((d) => !showProject || d.projectTitle === lane)
                .map((deploy) => (
                  <Tooltip key={deploy.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={deploy.message}
                        className={cn(
                          "focus-ring absolute top-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-background transition-transform hover:scale-150",
                          deploy.kind === "rollout"
                            ? "size-3 rotate-45 rounded-[2px] bg-foreground hover:rotate-45"
                            : cn("size-3 rounded-full", DOT[deploy.verdict]),
                        )}
                        style={{ left: x(Date.parse(deploy.at)) }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <Tip deploy={deploy} showProject={showProject} />
                    </TooltipContent>
                  </Tooltip>
                ))}
            </div>
          </div>
        ))}
        <div className="flex h-6 items-end gap-3">
          {showProject && <span className="w-32 shrink-0" />}
          <div className="relative h-full flex-1">
            {days.map((day, i) =>
              i % 2 === 0 || days.length <= 7 ? (
                <span
                  key={day}
                  className="text-meta absolute bottom-0 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: x(day + DAY_MS / 2) }}
                >
                  {new Date(day).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </MetricCard>
  );
}
