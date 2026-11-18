/**
 * Goals: the store's web revenue by year against its targets, and a timeline
 * from today to the end of next year. Each milestone projects the revenue
 * from three levers (sessions, conversion, average ticket) the user can move
 * from today's values to see what reaches the target.
 */

import { useState, type FormEvent } from "react";
import { Plus, RefreshCw01, Trash01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Slider } from "@decocms/ui/components/slider.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import type { MapStore } from "./site-map.tsx";

/** Web revenue per year, in millions of reais. */
export interface YearRevenue {
  year: number;
  actual?: number;
  target?: number;
}

/** Levers today, until the analysis measures them. */
const CONVERSION = 0.014;
const AVERAGE_TICKET = 450;
const EXAMPLE = [42, 56, 58, 72, 96];
const MONTH_WIDTH = 96;
const TIMELINE_START = 200;

/** Past years of actual revenue the form starts with, and how far back it goes. */
const DEFAULT_HISTORY = 2;
const MAX_HISTORY = 10;

function useFormats() {
  const [{ language }] = usePreferences();
  const money = new Intl.NumberFormat(language, {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return {
    millions: (value: number) => money.format(value * 1_000_000),
    count: new Intl.NumberFormat(language, {
      notation: "compact",
      maximumFractionDigits: 1,
    }),
    percent: new Intl.NumberFormat(language, {
      style: "percent",
      maximumFractionDigits: 1,
    }),
    ticket: new Intl.NumberFormat(language, {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0,
    }),
    month: new Intl.DateTimeFormat(language, { month: "short" }),
    language,
  };
}

function parseMillions(value: string): number | undefined {
  const number = Number(value.replace(",", "."));
  return value.trim() && Number.isFinite(number) && number >= 0
    ? number
    : undefined;
}

function GoalForm({
  current,
  initial,
  onSave,
}: {
  /** This year: actual so far plus a goal; next year takes only a goal. */
  current: number;
  initial: YearRevenue[] | null;
  onSave: (goals: YearRevenue[]) => void;
}) {
  const t = useT();
  const next = current + 1;
  const [history, setHistory] = useState(() =>
    initial
      ? initial.filter((row) => row.year < current).length
      : DEFAULT_HISTORY,
  );
  const oldest = current - history;
  const years = [
    ...Array.from({ length: history }, (_, index) => oldest + index),
    current,
    next,
  ];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initial ?? []).flatMap((row) => [
        [`${row.year}-actual`, row.actual?.toString() ?? ""],
        [`${row.year}-target`, row.target?.toString() ?? ""],
      ]),
    ),
  );
  const read = (year: number, kind: "actual" | "target") =>
    parseMillions(values[`${year}-${kind}`] ?? "");
  const ready =
    read(current, "actual") !== undefined &&
    read(current, "target") !== undefined &&
    read(next, "target") !== undefined;

  const fields: { year: number; actual: boolean; target: boolean }[] =
    years.map((year) => ({
      year,
      actual: year <= current,
      target: year >= current,
    }));

  const fillExample = () => {
    const [a, b, c, d, e] = EXAMPLE;
    setHistory(DEFAULT_HISTORY);
    setValues({
      [`${current - 2}-actual`]: String(a),
      [`${current - 1}-actual`]: String(b),
      [`${current}-actual`]: String(c),
      [`${current}-target`]: String(d),
      [`${next}-target`]: String(e),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    onSave(
      fields.map(({ year, actual, target }) => ({
        year,
        actual: actual ? read(year, "actual") : undefined,
        target: target ? read(year, "target") : undefined,
      })),
    );
  };

  return (
    <form
      onSubmit={submit}
      className="mx-auto flex w-full max-w-xl flex-col gap-6 surface p-6"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-medium text-foreground">
          {t("plan.goals.formTitle")}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">
          {t("plan.goals.formDescription")}
        </p>
      </div>
      <div className="grid grid-cols-[4rem_1fr_1fr_2rem] items-center gap-x-3 gap-y-2.5">
        <span />
        <span className="text-xs text-muted-foreground">
          {t("plan.goals.actual")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("plan.goals.target")}
        </span>
        <span />
        {history < MAX_HISTORY && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="col-span-4 justify-self-start"
            onClick={() => setHistory((count) => count + 1)}
          >
            <Plus />
            {t("plan.goals.addYear", { year: oldest - 1 })}
          </Button>
        )}
        {fields.map(({ year, actual, target }) => (
          <div key={year} className="contents">
            <span className="text-sm font-medium tabular-nums text-foreground">
              {year}
            </span>
            {(["actual", "target"] as const).map((kind) =>
              (kind === "actual" ? actual : target) ? (
                <Input
                  key={kind}
                  inputMode="decimal"
                  placeholder={t("plan.goals.placeholder")}
                  aria-label={t(
                    kind === "actual"
                      ? "plan.goals.actualFor"
                      : "plan.goals.targetFor",
                    { year },
                  )}
                  value={values[`${year}-${kind}`] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({
                      ...prev,
                      [`${year}-${kind}`]: event.target.value,
                    }))
                  }
                />
              ) : (
                <span
                  key={kind}
                  className="px-3 text-sm text-subtle-foreground"
                >
                  —
                </span>
              ),
            )}
            {year === oldest && history > 0 ? (
              <Button
                type="button"
                variant="ghost-destructive"
                size="icon-sm"
                aria-label={t("plan.goals.removeYear", { year })}
                onClick={() => {
                  setHistory((count) => count - 1);
                  setValues((prev) => {
                    const rest = { ...prev };
                    delete rest[`${year}-actual`];
                    return rest;
                  });
                }}
              >
                <Trash01 />
              </Button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("plan.goals.formHint", { year: current })}
      </p>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={fillExample}>
          {t("plan.goals.example")}
        </Button>
        <Button type="submit" disabled={!ready}>
          {t("plan.goals.save")}
        </Button>
      </div>
    </form>
  );
}

function growthOf(goals: YearRevenue[], index: number) {
  const row = goals[index];
  const previous = goals[index - 1];
  if (!row || !previous) return null;
  const base = previous.actual ?? previous.target;
  if (!base) return null;
  // A closed year grew by what it did; an open one is read by its target.
  if (row.target === undefined && row.actual !== undefined) {
    return { rate: row.actual / base - 1, planned: false };
  }
  if (row.target !== undefined) {
    return { rate: row.target / base - 1, planned: true };
  }
  return null;
}

function RevenueChart({ goals }: { goals: YearRevenue[] }) {
  const t = useT();
  const format = useFormats();
  const max = Math.max(
    1,
    ...goals.flatMap((row) => [row.actual ?? 0, row.target ?? 0]),
  );
  const height = (value: number | undefined) =>
    `${((value ?? 0) / max) * 100}%`;
  const signed = (rate: number) =>
    `${rate >= 0 ? "+" : ""}${format.percent.format(rate)}`;

  return (
    <section className="flex flex-col gap-5 surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium text-foreground">
          {t("plan.goals.chartTitle")}
        </h2>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] bg-chart-1" />
            {t("plan.goals.actual")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] border border-dashed border-chart-1" />
            {t("plan.goals.target")}
          </span>
        </div>
      </div>
      <div
        className="grid gap-x-4"
        style={{
          gridTemplateColumns: `6rem repeat(${goals.length}, minmax(0, 1fr))`,
        }}
      >
        <span />
        {goals.map((row) => (
          <div
            key={row.year}
            className="group relative flex h-44 items-end justify-center border-b border-border"
          >
            <div className="relative h-full w-14">
              {row.target !== undefined && (
                <div
                  className="absolute inset-x-0 bottom-0 rounded-t-[4px] border border-b-0 border-dashed border-chart-1 bg-chart-1/5"
                  style={{ height: height(row.target) }}
                />
              )}
              {row.actual !== undefined && (
                <div
                  className="absolute inset-x-1.5 bottom-0 rounded-t-[4px] bg-chart-1"
                  style={{ height: height(row.actual) }}
                />
              )}
            </div>
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full mb-1 rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background opacity-0 shadow-md transition-opacity group-hover:opacity-100"
            >
              {[
                row.actual !== undefined &&
                  t("plan.goals.tooltipActual", {
                    value: format.millions(row.actual),
                  }),
                row.target !== undefined &&
                  t("plan.goals.tooltipTarget", {
                    value: format.millions(row.target),
                  }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ))}
        <span />
        {goals.map((row) => (
          <span
            key={row.year}
            className="pt-2 text-center text-sm font-medium tabular-nums text-foreground"
          >
            {row.year}
          </span>
        ))}
        {(
          [
            ["plan.goals.actual", "actual"],
            ["plan.goals.target", "target"],
          ] as const
        ).map(([label, kind]) => (
          <div key={kind} className="contents">
            <span className="pt-2 text-xs text-muted-foreground">
              {t(label)}
            </span>
            {goals.map((row) => (
              <span
                key={row.year}
                className="pt-2 text-center text-sm tabular-nums text-foreground"
              >
                {row[kind] !== undefined ? format.millions(row[kind]) : "—"}
              </span>
            ))}
          </div>
        ))}
        <span className="pt-2 text-xs text-muted-foreground">
          {t("plan.goals.growth")}
        </span>
        {goals.map((row, index) => {
          const growth = growthOf(goals, index);
          return (
            <span
              key={row.year}
              className="pt-2 text-center text-sm tabular-nums text-muted-foreground"
            >
              {growth
                ? growth.planned
                  ? t("plan.goals.plannedGrowth", {
                      rate: signed(growth.rate),
                    })
                  : signed(growth.rate)
                : "—"}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function StoreBadge({
  store,
  className,
}: {
  store: MapStore;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "flex items-center justify-center text-center font-medium text-foreground",
        className,
      )}
    >
      {store.logo && !failed ? (
        <img
          src={store.logo}
          alt={store.name}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        store.name
      )}
    </span>
  );
}

interface Levers {
  sessions: number;
  conversion: number;
  ticket: number;
}

type LeverKey = keyof Levers;

function LeverSlider({
  label,
  value,
  today,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  today: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const min = today * 0.5;
  const max = today * 2;
  const share = (at: number) => `${((at - min) / (max - min)) * 100}%`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="font-medium tabular-nums text-foreground">
          {value === today
            ? format(value)
            : `${format(today)} → ${format(value)}`}
        </span>
      </div>
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-muted-foreground/50"
          style={{ left: share(today) }}
        />
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          thumbLabel={label}
          thumbValueText={format(value)}
          onValueChange={([next]) => {
            if (next !== undefined) onChange(next);
          }}
        />
      </div>
    </div>
  );
}

function MilestoneCard({
  store,
  title,
  monthName,
  target,
  yearBanked,
  yearTarget,
  today,
  saved,
  onSave,
}: {
  store: MapStore;
  title: string;
  monthName: string;
  /** This month's revenue goal, in millions. */
  target: number;
  /** The year's revenue before this month: made, or projected from earlier months. */
  yearBanked: number;
  /** The year's goal through this month. */
  yearTarget: number;
  today: Levers;
  /** The goals set for this month, if any. */
  saved: Levers | undefined;
  onSave: (levers: Levers) => void;
}) {
  const t = useT();
  const format = useFormats();
  const [editing, setEditing] = useState(saved === undefined);
  const [levers, setLevers] = useState(saved ?? today);
  const shown = editing ? levers : (saved ?? levers);
  const projection = (shown.sessions * shown.conversion * shown.ticket) / 1e6;
  const changed = (Object.keys(today) as LeverKey[]).some(
    (key) => levers[key] !== today[key],
  );
  const set = (key: LeverKey) => (value: number) =>
    setLevers((current) => ({ ...current, [key]: value }));
  const gap = target - projection;

  const rows: {
    key: LeverKey;
    label: string;
    step: number;
    format: (value: number) => string;
  }[] = [
    {
      key: "sessions",
      label: t("plan.goals.sessions"),
      step: 10_000,
      format: (value) => format.count.format(value),
    },
    {
      key: "conversion",
      label: t("plan.goals.conversion"),
      step: 0.0005,
      format: (value) => format.percent.format(value),
    },
    {
      key: "ticket",
      label: t("plan.goals.ticket"),
      step: 5,
      format: (value) => format.ticket.format(value),
    },
  ];

  return (
    <div className="flex w-[20rem] flex-col gap-4 surface p-5">
      <div className="flex flex-col items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {title}
        </span>
        <StoreBadge store={store} className="h-8 text-sm" />
        <span className="text-xl font-medium tabular-nums text-foreground">
          {t("plan.goals.progress", {
            actual: format.millions(projection),
            target: format.millions(target),
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("plan.goals.monthGoal", { month: monthName })}
        </span>
        {gap <= 0 ? (
          <Badge variant="success">{t("plan.goals.onTrack")}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("plan.goals.gap", { value: format.millions(gap) })}
          </span>
        )}
        <span className="mt-1 text-xs tabular-nums text-muted-foreground">
          {t("plan.goals.yearToDate", {
            month: monthName,
            actual: format.millions(yearBanked + projection),
            target: format.millions(yearTarget),
          })}
        </span>
      </div>
      {editing ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("plan.goals.leversIntro")}
          </p>
          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <LeverSlider
                key={row.key}
                label={row.label}
                value={levers[row.key]}
                today={today[row.key]}
                step={row.step}
                format={row.format}
                onChange={set(row.key)}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("plan.goals.yourGoals")}
          </p>
          <dl className="flex flex-col gap-2.5">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <dt className="text-foreground">{row.label}</dt>
                <dd className="font-medium tabular-nums text-foreground">
                  {shown[row.key] === today[row.key]
                    ? row.format(shown[row.key])
                    : `${row.format(today[row.key])} → ${row.format(shown[row.key])}`}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        {editing ? (
          <>
            {changed ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setLevers(today)}
              >
                <RefreshCw01 />
                {t("plan.goals.reset")}
              </Button>
            ) : (
              <span />
            )}
            <Button
              size="sm"
              onClick={() => {
                onSave(levers);
                setEditing(false);
              }}
            >
              {t("plan.goals.setGoals")}
            </Button>
          </>
        ) : (
          <>
            <Badge variant="lime">{t("plan.goals.goalsSet")}</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              {t("plan.goals.editGoals")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Scroll the timeline sideways so a newly opened month's card is in view. */
function revealCard(element: HTMLDivElement | null) {
  const scroller = element?.closest<HTMLElement>(".overflow-x-auto");
  if (!element || !scroller) return;
  const center = element.offsetLeft + element.offsetWidth / 2;
  scroller.scrollTo({
    left: center - scroller.clientWidth / 2,
    behavior: "smooth",
  });
}

/** A month on the timeline, as `YYYY-MM`. */
function monthKey(month: Date): string {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
}

const CARD_WIDTH = 320;

/** Share of a year's web revenue per month in Brazilian retail: Mother's Day, Father's Day, Black Friday, Christmas. */
const SEASONALITY = [7, 6.5, 7.5, 7.5, 9, 8, 7.5, 8, 7.5, 8, 12, 11.5];

/** A goal spread over months by weight, in millions, to one decimal. */
function spread(
  total: number,
  months: Date[],
  weight: (month: Date) => number,
): Record<string, number> {
  const weights = months.map(weight);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(
    months.map((month, index) => [
      monthKey(month),
      Math.round(((total * (weights[index] ?? 0)) / sum) * 10) / 10,
    ]),
  );
}

/** The months still open in each goal year, from this month to next December. */
function openMonths(now: Date): Date[] {
  return Array.from(
    { length: 12 - now.getMonth() + 12 },
    (_, index) => new Date(now.getFullYear(), now.getMonth() + index, 1),
  );
}

/** What each open month has to make: this year's remainder and next year's goal, by season. */
function defaultSplit(goals: YearRevenue[], now: Date): Record<string, number> {
  const year = now.getFullYear();
  const thisYear = goals.find((row) => row.year === year);
  const nextYear = goals.find((row) => row.year === year + 1);
  const months = openMonths(now);
  const seasonal = (month: Date) => SEASONALITY[month.getMonth()] ?? 1;
  return {
    ...spread(
      Math.max((thisYear?.target ?? 0) - (thisYear?.actual ?? 0), 0),
      months.filter((month) => month.getFullYear() === year),
      seasonal,
    ),
    ...spread(
      nextYear?.target ?? 0,
      months.filter((month) => month.getFullYear() === year + 1),
      seasonal,
    ),
  };
}

const YEAR_SPACING = 420;

function YearCard({
  store,
  year,
  target,
  banked,
  open,
  today,
  monthGoals,
  split,
  onPickMonth,
  onSave,
}: {
  store: MapStore;
  year: number;
  target: number;
  /** Revenue already made this year, in millions. */
  banked: number;
  /** The year's months still open, with their index on the timeline. */
  open: { month: Date; index: number }[];
  today: Levers;
  monthGoals: Record<string, Levers>;
  split: Record<string, number>;
  onPickMonth: (index: number) => void;
  /** Goals for every open month of the year at once. */
  onSave: (goals: Record<string, Levers>) => void;
}) {
  const t = useT();
  const format = useFormats();
  // Each month starts from its own goals, or today's pace.
  const base = open.map(({ month }) => monthGoals[monthKey(month)] ?? today);
  const baseSessions = base.reduce((sum, l) => sum + l.sessions, 0);
  const baseOrders = base.reduce(
    (sum, l) => sum + l.sessions * l.conversion,
    0,
  );
  const baseRevenue = base.reduce(
    (sum, l) => sum + l.sessions * l.conversion * l.ticket,
    0,
  );
  /** The year's levers: total sessions, and conversion and ticket weighted by month. */
  const aggregate: Levers = {
    sessions: baseSessions,
    conversion: baseSessions ? baseOrders / baseSessions : 0,
    ticket: baseOrders ? baseRevenue / baseOrders : 0,
  };
  const allSet =
    open.length > 0 &&
    open.every(({ month }) => monthGoals[monthKey(month)] !== undefined);
  const [editing, setEditing] = useState(!allSet);
  const [levers, setLevers] = useState(aggregate);
  // A year lever moves every month by the same ratio, so the split between months holds.
  const ratio = (key: LeverKey) =>
    editing && aggregate[key] ? levers[key] / aggregate[key] : 1;
  const factor = ratio("sessions") * ratio("conversion") * ratio("ticket");
  const monthLevers = base.map((l) => ({
    sessions: l.sessions * ratio("sessions"),
    conversion: l.conversion * ratio("conversion"),
    ticket: l.ticket * ratio("ticket"),
  }));
  const shown = editing ? levers : aggregate;
  const projection = banked + (baseRevenue * factor) / 1e6;
  const changed = (Object.keys(aggregate) as LeverKey[]).some(
    (key) => levers[key] !== aggregate[key],
  );
  const set = (key: LeverKey) => (value: number) =>
    setLevers((current) => ({ ...current, [key]: value }));
  const rows: {
    key: LeverKey;
    label: string;
    step: number;
    format: (value: number) => string;
  }[] = [
    {
      key: "sessions",
      label: t("plan.goals.yearSessions"),
      step: 50_000,
      format: (value) => format.count.format(value),
    },
    {
      key: "conversion",
      label: t("plan.goals.averageConversion"),
      step: 0.0005,
      format: (value) => format.percent.format(value),
    },
    {
      key: "ticket",
      label: t("plan.goals.ticket"),
      step: 5,
      format: (value) => format.ticket.format(value),
    },
  ];
  const gap = target - projection;
  const withGoals = open.filter(
    ({ month }) => monthGoals[monthKey(month)] !== undefined,
  ).length;
  const bars = open.map(({ month, index }, position) => {
    const levers = monthLevers[position] ?? today;
    return {
      month,
      index,
      goal: split[monthKey(month)] ?? 0,
      projected: (levers.sessions * levers.conversion * levers.ticket) / 1e6,
    };
  });
  const max = Math.max(
    0.0001,
    ...bars.flatMap((bar) => [bar.goal, bar.projected]),
  );

  return (
    <div className="flex w-[22rem] flex-col gap-4 surface p-5">
      <div className="flex flex-col items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {year}
        </span>
        <StoreBadge store={store} className="h-8 text-sm" />
        <span className="text-xl font-medium tabular-nums text-foreground">
          {t("plan.goals.progress", {
            actual: format.millions(projection),
            target: format.millions(target),
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("plan.goals.yearGoal", { year })}
        </span>
        {gap <= 0 ? (
          <Badge variant="success">{t("plan.goals.onTrack")}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("plan.goals.gap", { value: format.millions(gap) })}
          </span>
        )}
        {banked > 0 && (
          <span className="text-xs text-muted-foreground">
            {t("plan.goals.bankedSoFar", { value: format.millions(banked) })}
          </span>
        )}
      </div>
      {editing ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("plan.goals.yearLeversIntro")}
          </p>
          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <LeverSlider
                key={row.key}
                label={row.label}
                value={levers[row.key]}
                today={aggregate[row.key]}
                step={row.step}
                format={row.format}
                onChange={set(row.key)}
              />
            ))}
          </div>
        </>
      ) : (
        <dl className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <dt className="text-foreground">{row.label}</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {row.format(shown[row.key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{t("plan.goals.byMonth")}</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px] bg-chart-1" />
              {t("plan.goals.projection")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px] border border-dashed border-chart-1" />
              {t("plan.goals.target")}
            </span>
          </span>
        </div>
        <div className="flex items-end gap-1">
          {bars.map((bar) => (
            <button
              key={monthKey(bar.month)}
              type="button"
              onClick={() => onPickMonth(bar.index)}
              title={t("plan.goals.monthBar", {
                month: format.month.format(bar.month),
                projected: format.millions(bar.projected),
                goal: format.millions(bar.goal),
              })}
              className="group flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md pt-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="relative flex h-16 w-full max-w-6 items-end justify-center">
                <span
                  className="absolute inset-x-0 bottom-0 rounded-t-[3px] border border-b-0 border-dashed border-chart-1"
                  style={{ height: `${(bar.goal / max) * 100}%` }}
                />
                <span
                  className="absolute inset-x-1 bottom-0 rounded-t-[3px] bg-chart-1"
                  style={{ height: `${(bar.projected / max) * 100}%` }}
                />
              </span>
              <span className="text-[10px] text-muted-foreground capitalize">
                {format.month.format(bar.month).replace(".", "").slice(0, 3)}
              </span>
              {monthGoals[monthKey(bar.month)] !== undefined && (
                <span className="size-1 rounded-full bg-brand" />
              )}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {t("plan.goals.monthsWithGoals", {
            count: withGoals,
            total: open.length,
          })}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        {editing ? (
          <>
            {changed ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setLevers(aggregate)}
              >
                <RefreshCw01 />
                {t("plan.goals.reset")}
              </Button>
            ) : (
              <span />
            )}
            <Button
              size="sm"
              onClick={() => {
                onSave(
                  Object.fromEntries(
                    open.map(({ month }, position) => [
                      monthKey(month),
                      monthLevers[position] ?? today,
                    ]),
                  ),
                );
                setEditing(false);
              }}
            >
              {t("plan.goals.setGoals")}
            </Button>
          </>
        ) : (
          <>
            <Badge variant="lime">{t("plan.goals.goalsSet")}</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLevers(aggregate);
                setEditing(true);
              }}
            >
              {t("plan.goals.editGoals")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function YearTimeline({
  store,
  goals,
  now,
  months,
  actual,
  today,
  monthGoals,
  split,
  onPickMonth,
  onSave,
}: {
  store: MapStore;
  goals: YearRevenue[];
  now: Date;
  months: Date[];
  actual: number;
  today: Levers;
  monthGoals: Record<string, Levers>;
  split: Record<string, number>;
  onPickMonth: (index: number) => void;
  onSave: (goals: Record<string, Levers>) => void;
}) {
  const year = now.getFullYear();
  const years = [year, year + 1];
  const x = (index: number) => TIMELINE_START + (index + 0.5) * YEAR_SPACING;
  const width = x(years.length - 1) + 240;
  return (
    <div className="overflow-x-auto">
      <div className="relative h-[52rem]" style={{ width }}>
        <div className="absolute top-10 left-0 flex size-32 items-center justify-center">
          <StoreBadge
            store={store}
            className="size-full text-lg [&>img]:rounded-xl"
          />
        </div>
        <div
          className="absolute top-[6.5rem] h-0.5 bg-border"
          style={{ left: 144, width: width - 176 }}
        />
        <div
          className="absolute top-[6.5rem] size-2.5 -translate-y-1 rotate-45 border-t-2 border-r-2 border-border"
          style={{ left: width - 40 }}
        />
        {years.map((item, index) => {
          const target = goals.find((row) => row.year === item)?.target;
          const open = months
            .map((month, monthIndex) => ({ month, index: monthIndex }))
            .filter(({ month }) => month.getFullYear() === item);
          return (
            <div key={item}>
              <div
                className="absolute top-[5.5rem] flex -translate-x-1/2 flex-col items-center"
                style={{ left: x(index) }}
              >
                <span className="h-6 w-0.5 bg-foreground" />
                <span className="mt-2 rounded-full bg-foreground px-2.5 py-0.5 text-sm font-medium text-background">
                  {item}
                </span>
              </div>
              {target !== undefined && (
                <div
                  className="absolute top-[10rem] -translate-x-1/2"
                  style={{ left: x(index) }}
                >
                  <YearCard
                    store={store}
                    year={item}
                    target={target}
                    banked={item === year ? actual : 0}
                    open={open}
                    today={today}
                    monthGoals={monthGoals}
                    split={split}
                    onPickMonth={onPickMonth}
                    onSave={onSave}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Timeline({
  store,
  goals,
  now,
  monthGoals,
  split,
  onMonthGoals,
  onYearGoals,
}: {
  store: MapStore;
  goals: YearRevenue[];
  now: Date;
  monthGoals: Record<string, Levers>;
  /** Each open month's revenue goal, in millions. */
  split: Record<string, number>;
  onMonthGoals: (key: string, levers: Levers) => void;
  onYearGoals: (goals: Record<string, Levers>) => void;
}) {
  const t = useT();
  const format = useFormats();
  const [{ language }] = usePreferences();
  const year = now.getFullYear();
  const thisYear = goals.find((row) => row.year === year);
  const months = openMonths(now);
  // The months closed so far set today's monthly pace; every lever starts there.
  const closedMonths = Math.max(now.getMonth(), 1);
  const actual = thisYear?.actual ?? 0;
  const monthly = (actual / closedMonths) * 1e6;
  const today: Levers = {
    sessions: monthly / (CONVERSION * AVERAGE_TICKET),
    conversion: CONVERSION,
    ticket: AVERAGE_TICKET,
  };
  const yearEnd = months.findIndex(
    (month) => month.getFullYear() === year && month.getMonth() === 11,
  );
  const nextEnd = months.length - 1;
  const [selected, setSelected] = useState(Math.max(yearEnd, 0));
  const [scale, setScale] = useState<"month" | "year">("month");

  const x = (index: number) => TIMELINE_START + (index + 0.5) * MONTH_WIDTH;
  const width = x(nextEnd) + CARD_WIDTH / 2 + 48;
  const longMonth = new Intl.DateTimeFormat(language, {
    month: "long",
    year: "numeric",
  });
  const monthName = new Intl.DateTimeFormat(language, { month: "long" });

  const revenueOf = (levers: Levers) =>
    (levers.sessions * levers.conversion * levers.ticket) / 1e6;
  /** The year up to a month: what is made, plus earlier open months at their goals or today's pace. */
  const yearBefore = (index: number) => {
    const month = months[index];
    if (!month) return { banked: 0, target: 0 };
    const isThisYear = month.getFullYear() === year;
    const start = isThisYear ? actual : 0;
    const earlier = months
      .slice(0, index)
      .filter((other) => other.getFullYear() === month.getFullYear());
    return {
      banked:
        start +
        earlier.reduce(
          (sum, other) => sum + revenueOf(monthGoals[monthKey(other)] ?? today),
          0,
        ),
      target:
        start +
        earlier.reduce((sum, other) => sum + (split[monthKey(other)] ?? 0), 0),
    };
  };
  const selectedMonth = months[selected];
  const before = yearBefore(selected);
  const selectedTarget = selectedMonth
    ? split[monthKey(selectedMonth)]
    : undefined;
  const cardLeft = Math.min(
    Math.max(x(selected) - CARD_WIDTH / 2, 0),
    width - CARD_WIDTH,
  );

  return (
    <section className="flex flex-col gap-3 surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium text-foreground">
            {t("plan.goals.timelineTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(
              scale === "month"
                ? "plan.goals.timelineHint"
                : "plan.goals.timelineYearHint",
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(["month", "year"] as const).map((option) => (
            <Button
              key={option}
              variant="tab"
              size="sm"
              aria-pressed={scale === option}
              onClick={() => setScale(option)}
            >
              {t(
                option === "month"
                  ? "plan.goals.scaleMonth"
                  : "plan.goals.scaleYear",
              )}
            </Button>
          ))}
        </div>
      </div>
      {scale === "year" ? (
        <YearTimeline
          store={store}
          goals={goals}
          now={now}
          months={months}
          actual={actual}
          today={today}
          monthGoals={monthGoals}
          split={split}
          onPickMonth={(index) => {
            setSelected(index);
            setScale("month");
          }}
          onSave={onYearGoals}
        />
      ) : (
        <div className="overflow-x-auto">
          <div className="relative h-[42rem]" style={{ width }}>
            <div className="absolute top-10 left-0 flex size-32 items-center justify-center">
              <StoreBadge
                store={store}
                className="size-full text-lg [&>img]:rounded-xl"
              />
            </div>
            <div
              className="absolute top-[6.5rem] h-0.5 bg-border"
              style={{ left: 144, width: width - 176 }}
            />
            <div
              className="absolute top-[6.5rem] size-2.5 -translate-y-1 rotate-45 border-t-2 border-r-2 border-border"
              style={{ left: width - 40 }}
            />
            {months.map((month, index) => {
              const milestone = index === yearEnd || index === nextEnd;
              const showYear = month.getMonth() === 0 || index === 0;
              const isSelected = index === selected;
              const hasGoals = monthGoals[monthKey(month)] !== undefined;
              return (
                <button
                  key={month.toISOString()}
                  type="button"
                  onClick={() => setSelected(index)}
                  aria-pressed={isSelected}
                  aria-label={longMonth.format(month)}
                  className="group absolute top-[5.5rem] flex w-20 -translate-x-1/2 flex-col items-center rounded-lg pb-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ left: x(index) }}
                >
                  <span
                    className={cn(
                      "h-6 w-0.5 bg-border transition-colors group-hover:bg-muted-foreground",
                      (milestone || isSelected) && "bg-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "mt-2 rounded-full px-2 py-0.5 text-sm capitalize transition-colors group-hover:bg-accent",
                      isSelected
                        ? "bg-foreground font-medium text-background group-hover:bg-foreground"
                        : milestone || index === 0
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {format.month.format(month).replace(".", "")}
                    {showYear || milestone ? ` ${month.getFullYear()}` : ""}
                  </span>
                  {index === 0 && (
                    <span className="mt-0.5 w-20 text-center text-xs text-balance text-muted-foreground">
                      {t("plan.goals.today", {
                        conversion: format.percent.format(CONVERSION),
                      })}
                    </span>
                  )}
                  {hasGoals && (
                    <span
                      aria-label={t("plan.goals.goalsSet")}
                      className="mt-1 size-1.5 rounded-full bg-brand"
                    />
                  )}
                </button>
              );
            })}
            {selectedMonth && selectedTarget !== undefined && (
              <div
                key={monthKey(selectedMonth)}
                ref={revealCard}
                className="absolute top-[12.5rem]"
                style={{ left: cardLeft }}
              >
                <MilestoneCard
                  key={monthKey(selectedMonth)}
                  store={store}
                  title={longMonth.format(selectedMonth)}
                  monthName={monthName.format(selectedMonth)}
                  target={selectedTarget}
                  yearBanked={before.banked}
                  yearTarget={before.target + selectedTarget}
                  today={today}
                  saved={monthGoals[monthKey(selectedMonth)]}
                  onSave={(levers) =>
                    onMonthGoals(monthKey(selectedMonth), levers)
                  }
                />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function MonthlySplit({
  goals,
  now,
  split,
  onChange,
}: {
  goals: YearRevenue[];
  now: Date;
  split: Record<string, number>;
  onChange: (values: Record<string, number>) => void;
}) {
  const t = useT();
  const format = useFormats();
  const year = now.getFullYear();
  const [shownYear, setShownYear] = useState(year + 1);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const months = openMonths(now).filter(
    (month) => month.getFullYear() === shownYear,
  );
  const row = goals.find((item) => item.year === shownYear);
  // This year only its open months are left to plan: the goal minus what is made.
  const required =
    shownYear === year
      ? Math.max((row?.target ?? 0) - (row?.actual ?? 0), 0)
      : (row?.target ?? 0);
  const values = months.map((month) => split[monthKey(month)] ?? 0);
  const sum = values.reduce((a, b) => a + b, 0);
  const max = Math.max(...values, 0.0001);
  const diff = sum - required;
  const decimal = new Intl.NumberFormat(format.language, {
    maximumFractionDigits: 1,
  });

  const commit = (key: string) => {
    const value = parseMillions(drafts[key] ?? "");
    if (value !== undefined) onChange({ [key]: value });
    setDrafts((current) => {
      const rest = { ...current };
      delete rest[key];
      return rest;
    });
  };

  return (
    <section className="flex flex-col gap-5 surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium text-foreground">
            {t("plan.goals.splitTitle")}
          </h2>
          <p className="text-xs text-pretty text-muted-foreground">
            {t("plan.goals.splitDescription")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {[year, year + 1].map((option) => (
            <Button
              key={option}
              variant="tab"
              size="sm"
              aria-pressed={shownYear === option}
              onClick={() => setShownYear(option)}
            >
              {option === year
                ? t("plan.goals.splitRest", { year: option })
                : option}
            </Button>
          ))}
        </div>
      </div>
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`,
        }}
      >
        {months.map((month, index) => {
          const key = monthKey(month);
          const value = values[index] ?? 0;
          return (
            <div key={key} className="flex min-w-0 flex-col items-center gap-2">
              <div className="flex h-28 w-full items-end justify-center border-b border-border">
                <div
                  className="w-full max-w-10 rounded-t-[4px] bg-chart-1 transition-[height]"
                  style={{ height: `${(value / max) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground capitalize">
                {format.month.format(month).replace(".", "")}
              </span>
              <Input
                size="sm"
                inputMode="decimal"
                aria-label={t("plan.goals.monthGoal", {
                  month: format.month.format(month),
                })}
                value={drafts[key] ?? decimal.format(value)}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                onBlur={() => commit(key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit(key);
                }}
                className="px-1 text-center tabular-nums"
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-3 text-sm">
          <span className="tabular-nums text-foreground">
            {t("plan.goals.splitSum", {
              sum: format.millions(sum),
              target: format.millions(required),
            })}
          </span>
          {Math.abs(diff) < 0.05 ? (
            <Badge variant="success">{t("plan.goals.splitMatches")}</Badge>
          ) : (
            <Badge variant="warning">
              {diff < 0
                ? t("plan.goals.splitShort", {
                    value: format.millions(-diff),
                  })
                : t("plan.goals.splitOver", { value: format.millions(diff) })}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onChange(
                spread(
                  required,
                  months,
                  (month) => SEASONALITY[month.getMonth()] ?? 1,
                ),
              )
            }
          >
            {t("plan.goals.splitSeasonal")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onChange(spread(required, months, () => 1))}
          >
            {t("plan.goals.splitEven")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function GoalsView({
  store,
  goals,
  onGoals,
}: {
  store: MapStore;
  goals: YearRevenue[] | null;
  onGoals: (goals: YearRevenue[]) => void;
}) {
  const t = useT();
  const [now] = useState(() => new Date());
  const [editing, setEditing] = useState(goals === null);
  const [monthGoals, setMonthGoals] = useState<Record<string, Levers>>({});
  const [splitOverrides, setSplitOverrides] = useState<Record<string, number>>(
    {},
  );

  if (editing || !goals) {
    return (
      <div className="h-full overflow-y-auto px-6 py-10">
        <GoalForm
          current={now.getFullYear()}
          initial={goals}
          onSave={(next) => {
            onGoals(next);
            // New yearly goals re-spread every month.
            setSplitOverrides({});
            setEditing(false);
          }}
        />
      </div>
    );
  }

  const split = { ...defaultSplit(goals, now), ...splitOverrides };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        <div className="flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t("plan.goals.edit")}
          </Button>
        </div>
        <RevenueChart goals={goals} />
        <MonthlySplit
          goals={goals}
          now={now}
          split={split}
          onChange={(values) =>
            setSplitOverrides((current) => ({ ...current, ...values }))
          }
        />
        <Timeline
          store={store}
          goals={goals}
          now={now}
          monthGoals={monthGoals}
          split={split}
          onMonthGoals={(key, levers) =>
            setMonthGoals((current) => ({ ...current, [key]: levers }))
          }
          onYearGoals={(goals) =>
            setMonthGoals((current) => ({ ...current, ...goals }))
          }
        />
      </div>
    </div>
  );
}
