/**
 * The org Overview under the new navigation, built only from what the page
 * already loads: the board, the inbox and the app history. Three bands —
 * where you were (recent apps), what wants you today (mentions and the
 * actionable queue), and how each project is moving (a few rhythms).
 */

import type { ReactNode } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle, Eye, HelpCircle } from "@untitledui/icons";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { ProjectIcon } from "@/components/project-icon";
import {
  AppsCard,
  PROJECT_APPS,
  TILE_FACE,
} from "@/components/projects/project-apps";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import type { InboxTaskUpdate } from "@/hooks/use-inbox-feed";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { agentRunState, type TaskBoardItem } from "@/layouts/task-board/config";
import { taskRouteSegment } from "@/layouts/task-board/task-route";
import { projectForTask, type ProjectIndex } from "@/lib/project-index";
import type { RecentApp } from "@/lib/recent-apps";
import {
  attentionReason,
  costSeriesMonthToDate,
  formatUsd,
  RHYTHM_DAYS,
  runsSeries,
  shippedSeries,
} from "./daily-pulse";

/** The apps you last had open, as tiles. Hidden until you have opened one. */
export function RecentApps({
  recent,
  orgSlug,
}: {
  recent: readonly RecentApp[];
  orgSlug: string;
}) {
  const t = useT();
  const tiles = recent.slice(0, 8).flatMap((entry) => {
    const params = { org: orgSlug, agentId: entry.projectId };
    if (entry.connection) {
      const { label, icon, id, toolName } = entry.connection;
      return [
        {
          key: `${id}:${toolName}:${entry.projectId}`,
          label,
          project: entry.projectTitle,
          link: {
            to: PROJECT_ROUTE.app,
            params: { ...params, connectionId: id, toolName },
          },
          glyph: (
            <AgentAvatar
              icon={icon}
              name={label}
              size="md"
              className={TILE_FACE}
            />
          ),
        },
      ];
    }
    const app = PROJECT_APPS[entry.app as keyof typeof PROJECT_APPS];
    if (!app) return [];
    return [
      {
        key: `${entry.app}:${entry.projectId}`,
        label: t(app.labelKey),
        project: entry.projectTitle,
        link: { to: app.to, params },
        glyph: (
          <span className={cn(TILE_FACE, "flex items-center", app.tone)}>
            <app.Icon size={24} />
          </span>
        ),
      },
    ];
  });
  if (tiles.length === 0) return null;

  return (
    <AppsCard title={t("home.overview.recentApps")}>
      {tiles.map((tile) => (
        <Link
          key={tile.key}
          to={tile.link.to}
          params={tile.link.params}
          className="group flex shrink-0 flex-col items-center gap-2.5 rounded-xl p-3 text-center transition-[background-color,transform] duration-150 ease-out hover:bg-accent active:scale-[0.97]"
        >
          {tile.glyph}
          <span className="flex w-full min-w-0 flex-col">
            <span className="line-clamp-2 text-xs font-medium break-words text-foreground">
              {tile.label}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {tile.project}
            </span>
          </span>
        </Link>
      ))}
    </AppsCard>
  );
}

function taskLink(
  orgSlug: string,
  task: { keySeq: number | null; id: string },
) {
  return {
    to: DESTINATION_ROUTE.tasks,
    params: { org: orgSlug, taskKey: taskRouteSegment(orgSlug, task) },
  };
}

type QueueKind = "answer" | "failed" | "review" | "running" | "assigned";

const QUEUE: Record<
  QueueKind,
  { Icon: typeof CheckCircle; tone: string; reasonKey: TranslationKey }
> = {
  answer: {
    Icon: HelpCircle,
    tone: "text-warning",
    reasonKey: "home.needsYou.reasonAnswer",
  },
  failed: {
    Icon: AlertCircle,
    tone: "text-destructive",
    reasonKey: "home.overview.reasonFailed",
  },
  review: {
    Icon: Eye,
    tone: "text-warning",
    reasonKey: "home.needsYou.reasonReview",
  },
  running: {
    Icon: CheckCircle,
    tone: "text-muted-foreground",
    reasonKey: "home.overview.reasonRunning",
  },
  assigned: {
    Icon: CheckCircle,
    tone: "text-muted-foreground",
    reasonKey: "home.needsYou.reasonAssigned",
  },
};

/** Most urgent first: a question blocks, a dead run is already broken. */
const QUEUE_ORDER: QueueKind[] = [
  "answer",
  "failed",
  "review",
  "running",
  "assigned",
];

/** The actionable queue: cards waiting on you, then every live or dead run,
 *  each card once, most urgent first. */
export function queueRows(
  waiting: readonly TaskBoardItem[],
  tasks: readonly TaskBoardItem[],
): { task: TaskBoardItem; kind: QueueKind }[] {
  const seen = new Set<string>();
  const rows: { task: TaskBoardItem; kind: QueueKind }[] = [];
  const add = (task: TaskBoardItem, kind: QueueKind) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    rows.push({ task, kind });
  };
  for (const task of waiting) add(task, attentionReason(task));
  for (const task of tasks) {
    const run = agentRunState(task);
    if (run === "failed") add(task, "failed");
    else if (run === "running") add(task, "running");
  }
  return rows.sort(
    (a, b) => QUEUE_ORDER.indexOf(a.kind) - QUEUE_ORDER.indexOf(b.kind),
  );
}

type ForYouItem =
  | { kind: QueueKind; task: TaskBoardItem; mention: InboxTaskUpdate | null }
  | { kind: "mention"; task: null; mention: InboxTaskUpdate };

/** One row per card. A mention rides on its card's queue row; a mention on a
 *  card the queue does not hold gets its own row, after the questions. A
 *  mention of you beats a plain comment; otherwise the newest wins. */
export function forYouItems(
  queue: readonly { task: TaskBoardItem; kind: QueueKind }[],
  updates: readonly InboxTaskUpdate[],
): ForYouItem[] {
  const byTask = new Map<string, InboxTaskUpdate>();
  for (const update of updates) {
    if (update.action !== "mentioned" && update.action !== "commented")
      continue;
    const held = byTask.get(update.taskBoardItemId);
    if (!held || (held.action !== "mentioned" && update.action === "mentioned"))
      byTask.set(update.taskBoardItemId, update);
  }
  const queued = new Set(queue.map((row) => row.task.id));
  const loose: ForYouItem[] = [...byTask.values()]
    .filter((mention) => !queued.has(mention.taskBoardItemId))
    .map((mention) => ({ kind: "mention", task: null, mention }));
  const rows: ForYouItem[] = queue.map(({ task, kind }) => ({
    kind,
    task,
    mention: byTask.get(task.id) ?? null,
  }));
  const answers = rows.filter((row) => row.kind === "answer");
  const rest = rows.filter((row) => row.kind !== "answer");
  return [...answers, ...loose, ...rest];
}

const ROWS = 7;

function MentionAvatar({ mention }: { mention: InboxTaskUpdate }) {
  const t = useT();
  const actor = mention.actorName ?? t("home.overview.someone");
  return (
    <Avatar
      url={mention.actorImage ?? undefined}
      fallback={actor}
      shape="circle"
      size="2xs"
    />
  );
}

function mentionLine(
  mention: InboxTaskUpdate,
  t: ReturnType<typeof useT>,
): string {
  const actor = mention.actorName ?? t("home.overview.someone");
  return t(
    mention.action === "mentioned"
      ? "home.overview.mentioned"
      : "home.overview.commented",
    { actor },
  );
}

/** Everything asking for you, one line per card: what it is, why it is here,
 *  and where it lives. */
export function ForYou({
  waiting,
  tasks,
  mentions,
  index,
  orgSlug,
}: {
  waiting: readonly TaskBoardItem[];
  tasks: readonly TaskBoardItem[];
  mentions: readonly InboxTaskUpdate[];
  index: ProjectIndex;
  orgSlug: string;
}) {
  const t = useT();
  const items = forYouItems(queueRows(waiting, tasks), mentions);

  return (
    <section className="flex flex-col gap-2 surface p-3">
      <h2 className="flex items-center gap-2 px-2 pt-1 pb-1 text-sm font-medium text-foreground">
        {t("home.overview.forYou")}
        {items.length > 0 && (
          <span className="text-muted-foreground tabular-nums">
            {items.length}
          </span>
        )}
      </h2>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-2 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-success/10 text-success">
            <CheckCircle size={20} />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              {t("home.overview.allClearTitle")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("home.overview.allClearDescription")}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {items.slice(0, ROWS).map((item) => {
            const target =
              item.kind === "mention"
                ? {
                    id: item.mention.taskBoardItemId,
                    keySeq: item.mention.taskKeySeq,
                    title: item.mention.taskTitle,
                  }
                : item.task;
            const project = item.task ? projectForTask(item.task, index) : null;
            const config = item.kind === "mention" ? null : QUEUE[item.kind];
            const reason = item.mention
              ? mentionLine(item.mention, t)
              : config
                ? t(config.reasonKey)
                : "";
            return (
              <Link
                key={target.id}
                {...taskLink(orgSlug, target)}
                className="group flex h-10 items-center gap-3 rounded-lg px-2 transition-colors hover:bg-accent"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center",
                    config?.tone,
                  )}
                >
                  {item.kind === "mention" ? (
                    <MentionAvatar mention={item.mention} />
                  ) : item.kind === "running" ? (
                    <Spinner className="size-3.5" />
                  ) : config ? (
                    <config.Icon size={16} />
                  ) : null}
                </span>
                <span className="min-w-0 truncate text-sm text-foreground">
                  {target.title}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground">
                  {item.kind !== "mention" && item.mention && (
                    <MentionAvatar mention={item.mention} />
                  )}
                  <span className="truncate">{reason}</span>
                </span>
                {project && (
                  <span className="hidden max-w-48 shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:flex">
                    <ProjectIcon icon={project.icon} name={project.title} />
                    <span className="truncate">{project.title}</span>
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** A scale's top: the next round number at or above the peak, so the axis
 *  reads in whole steps. */
export function niceMax(peak: number): number {
  if (peak <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(peak));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * step >= peak) return factor * step;
  }
  return 10 * step;
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** One bar per day against a 0..max scale, an average line across it, the
 *  scale on the right and three dates under it — the Figma goal card, with
 *  the period's average where a goal would sit. Hovering a bar reads its day. */
function BarChart({
  series,
  start,
  format,
  label,
  averageLabel,
}: {
  series: readonly number[];
  /** The first bar's day. */
  start: Date;
  format: (value: number) => string;
  /** What a bar counts, for its tooltip. */
  label: string;
  averageLabel: (value: string) => string;
}) {
  const max = niceMax(Math.max(...series, 0));
  const average =
    series.length === 0
      ? 0
      : series.reduce((total, n) => total + n, 0) / series.length;
  const rows = series.map((value, day) => ({
    day: shortDate.format(new Date(start.getTime() + day * 86_400_000)),
    value,
  }));
  const last = Math.max(rows.length - 1, 0);
  const ticks = [
    rows[0]?.day,
    rows[Math.round(last / 2)]?.day,
    rows[last]?.day,
  ].filter((tick): tick is string => !!tick);
  const config = { value: { label, color: "var(--chart-1)" } };

  return (
    <ChartContainer config={config} className="aspect-auto h-[159px] w-full">
      <RechartsBarChart
        data={rows}
        margin={{ top: 8, right: 0, bottom: 0, left: 0 }}
        barCategoryGap="30%"
      >
        <CartesianGrid
          vertical={false}
          strokeDasharray="4 4"
          stroke="var(--border)"
        />
        <XAxis
          dataKey="day"
          ticks={ticks}
          interval="preserveStartEnd"
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          tickMargin={8}
        />
        <YAxis
          orientation="right"
          domain={[0, max]}
          ticks={[0, max / 2, max]}
          tickFormatter={(value: number) => (value === 0 ? "0" : format(value))}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          width={44}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={
            <ChartTooltipContent
              indicator="line"
              formatter={(value) => (
                <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {format(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        {average > 0 && (
          <ReferenceLine
            y={average}
            stroke="var(--foreground)"
            strokeOpacity={0.6}
            strokeDasharray="2 2"
            label={{
              value: averageLabel(format(average)),
              position: "insideBottomLeft",
              fontSize: 12,
              fill: "var(--foreground)",
            }}
          />
        )}
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          radius={[2, 2, 0, 0]}
          maxBarSize={4}
          animationDuration={300}
        />
      </RechartsBarChart>
    </ChartContainer>
  );
}

function MetricCard({
  label,
  value,
  chart,
}: {
  label: string;
  value: string;
  chart: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6 surface p-5">
      <div className="flex flex-col gap-2.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-[32px] leading-none font-medium tracking-tight tabular-nums text-foreground">
          {value}
        </span>
      </div>
      {chart}
    </section>
  );
}

/** Three rhythms over the given cards (the org's, or one project's): how
 *  much ships, how hard the agents work, what that costs. */
export function Metrics({ tasks }: { tasks: readonly TaskBoardItem[] }) {
  const t = useT();
  const shipped = shippedSeries(tasks, RHYTHM_DAYS);
  const runs = runsSeries(tasks, RHYTHM_DAYS);
  const cost = costSeriesMonthToDate(tasks);
  const sum = (series: readonly number[]) =>
    series.reduce((total, n) => total + n, 0);
  const today = new Date();
  const windowStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - (RHYTHM_DAYS - 1),
  );
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const count = (n: number) => String(Math.round(n * 10) / 10);
  const averageLabel = (value: string) => t("home.overview.average", { value });

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <MetricCard
        label={t("home.overview.delivered")}
        value={String(sum(shipped))}
        chart={
          <BarChart
            label={t("home.overview.delivered")}
            series={shipped}
            start={windowStart}
            format={count}
            averageLabel={averageLabel}
          />
        }
      />
      <MetricCard
        label={t("home.overview.agentRuns")}
        value={String(sum(runs))}
        chart={
          <BarChart
            label={t("home.overview.agentRuns")}
            series={runs}
            start={windowStart}
            format={count}
            averageLabel={averageLabel}
          />
        }
      />
      <MetricCard
        label={t("home.overview.agentCost")}
        value={formatUsd(sum(cost))}
        chart={
          <BarChart
            label={t("home.overview.agentCost")}
            series={cost}
            start={monthStart}
            format={formatUsd}
            averageLabel={averageLabel}
          />
        }
      />
    </div>
  );
}
