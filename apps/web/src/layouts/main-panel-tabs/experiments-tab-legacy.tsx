/**
 * The Experiments tab as it shipped before `experiments_v2_enabled`: a table,
 * a create dialog, and a results panel over experiment metadata only.
 *
 * Kept verbatim rather than rebuilt so an org without the flag sees exactly
 * what main shipped. Delete this file, its `experiments.legacy.*` /
 * `experiments.col.*` / `experiments.results.*` strings, and the flag together.
 */
import { Fragment, type ReactNode, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ChartContainer,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { type TFunction, type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useClockTick } from "@/lib/use-clock-tick";
import {
  type Experiment,
  type ExperimentStatus,
  useCreateExperiment,
  useDeleteExperiment,
  useExperimentResults,
  useExperiments,
  useUpdateExperiment,
} from "@/hooks/use-experiments";
import {
  type ArmCounts,
  type Comparison,
  compareArms,
  cumulativeLift,
  DEFF,
  daysRunning,
  daysToMargin,
  liftAxis,
  MIN_SUCCESSES,
  MIN_TOTAL,
  NON_INFERIORITY,
  TARGET_LIFT,
  type Verdict,
} from "./experiment-results-model";

const STATUSES: ExperimentStatus[] = ["draft", "running", "paused", "ended"];

interface VariantForm {
  id: string;
  weight: string;
  role: "" | "control" | "treatment";
}

const BLANK_VARIANTS: VariantForm[] = [
  { id: "control", weight: "50", role: "control" },
  { id: "variant-b", weight: "50", role: "treatment" },
];

function Variants({ variants }: { variants: Experiment["variants"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {variants.map((v) => (
        <span
          key={v.id}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
        >
          {v.id} {v.weight}%
        </span>
      ))}
    </div>
  );
}

function CreateDialog({
  site,
  open,
  onOpenChange,
}: {
  site: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const create = useCreateExperiment(site);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [variants, setVariants] = useState<VariantForm[]>(BLANK_VARIANTS);

  const sum = variants.reduce((a, v) => a + (Number(v.weight) || 0), 0);
  const setVar = (i: number, patch: Partial<VariantForm>) =>
    setVariants((vs) =>
      vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)),
    );

  const submit = () => {
    create.mutate(
      {
        key: key.trim(),
        name: name.trim(),
        variants: variants.map((v) => ({
          id: v.id.trim(),
          weight: Number(v.weight) || 0,
          role: v.role || null,
        })),
      },
      {
        onSuccess: () => {
          setKey("");
          setName("");
          setVariants(BLANK_VARIANTS);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("experiments.dialog.newTitle")}</DialogTitle>
          <DialogDescription>{t("experiments.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">
                {t("experiments.legacy.dialog.key")}
              </Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Cross Sell Bag"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t("experiments.dialog.name")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="PLP ranking"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                {t("experiments.dialog.variants")} —{" "}
                {t("experiments.dialog.weightSum", { sum })}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setVariants((vs) => [
                    ...vs,
                    { id: "", weight: "0", role: "" },
                  ])
                }
              >
                {t("experiments.dialog.addVariant")}
              </Button>
            </div>
            {variants.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional editable rows
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={v.id}
                  onChange={(e) => setVar(i, { id: e.target.value })}
                  placeholder="id"
                  size="sm"
                  className="flex-1"
                />
                <Input
                  value={v.weight}
                  onChange={(e) => setVar(i, { weight: e.target.value })}
                  inputMode="numeric"
                  size="sm"
                  className="w-16"
                />
                <select
                  value={v.role}
                  onChange={(e) =>
                    setVar(i, { role: e.target.value as VariantForm["role"] })
                  }
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                >
                  <option value="">role…</option>
                  <option value="control">control</option>
                  <option value="treatment">treatment</option>
                </select>
              </div>
            ))}
          </div>
          {create.error && (
            <p className="text-xs text-destructive">
              {create.error instanceof Error ? create.error.message : "Error"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("experiments.dialog.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending || !key.trim() || !name.trim()}
          >
            {t("experiments.dialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ResultsData = NonNullable<ReturnType<typeof useExperimentResults>["data"]>;
type ResultsBody = NonNullable<ResultsData["results"]>;
type Behaviour = NonNullable<
  NonNullable<ResultsBody["arms"]>[number]["behaviour"]
>;

/** One arm as the screen reads it, whichever backend answered. */
interface ArmView {
  id: string;
  /** What people call the version: its description when short, else its id. */
  name: string;
  role: "control" | "test" | null;
  weight: number | null;
  visitors: number;
  exposed: number | null;
  /** The decision metric: conversion among the exposed, else among visitors. */
  counts: ArmCounts;
  purchases: number | null;
  revenue: number | null;
  behaviour: Behaviour | null;
  daily: { date: string; counts: ArmCounts }[];
}

const GOAL_LABELS: Record<string, TranslationKey> = {
  purchase: "experiments.results.goalName.purchase",
  experience_impression: "experiments.results.goalName.experience_impression",
  visitors: "experiments.results.visitors",
};

/** Known event names in words; any other goal as configured. */
function goalLabel(goal: string, t: TFunction): string {
  const key = GOAL_LABELS[goal];
  return key ? t(key) : goal;
}

const STATUS_LABELS: Record<ExperimentStatus, TranslationKey> = {
  draft: "experiments.status.draft",
  running: "experiments.status.running",
  paused: "experiments.status.paused",
  ended: "experiments.status.ended",
};

const VERDICT_TONE: Record<Verdict, string> = {
  few: "text-muted-foreground",
  unclear: "text-foreground",
  notWorse: "text-foreground",
  better: "text-success",
  worse: "text-destructive",
};

const fmt = (n: number, options: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(undefined, options).format(n);
const num = (n: number) => fmt(n, { maximumFractionDigits: 0 });
const dec = (n: number) =>
  fmt(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (n: number, digits = 1) =>
  fmt(n, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const signedPct = (n: number, digits = 1) =>
  fmt(n, {
    style: "percent",
    signDisplay: "exceptZero",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
// ponytail: revenue without a named currency is read as BRL, every Deco
// Analytics store so far; name it in the payload before that stops holding.
const money = (n: number, currency: string) =>
  fmt(n, { style: "currency", currency });
const ratio = (a: number | null, b: number | null) =>
  a !== null && b ? a / b : null;

/** Seconds as "1 min 37 s". */
function duration(seconds: number, t: TFunction): string {
  const s = Math.round(seconds);
  return s >= 60
    ? t("experiments.results.minutes", { m: Math.floor(s / 60), s: s % 60 })
    : t("experiments.results.seconds", { s });
}

const NAME_MAX = 40;

/** A variant's description reads as its name ("Carrinho novo") when it is one
 *  short line; a longer description is an explanation, so the id stays. */
function armName(variants: Experiment["variants"], id: string): string {
  const d = variants.find((v) => v.id === id)?.description?.trim();
  return d && d.length <= NAME_MAX && !/[\r\n]/.test(d) ? d : id;
}

/** Control first, then the treatment, then any other arm. */
function toArms(r: ResultsBody, variants: Experiment["variants"]): ArmView[] {
  const arms = r.arms ?? [];
  const weight = (id: string) =>
    variants.find((v) => v.id === id)?.weight ?? null;
  if (arms.length === 0) {
    // OneDollarStats: two sides and goal counts, no exposure.
    const goal = r.goals.find((g) => g.goal !== "visitors");
    const side = (key: "default" | "variant"): ArmView => {
      const v = variants.find((x) =>
        key === "default" ? x.role === "control" : x.role === "treatment",
      );
      return {
        id: v?.id ?? key,
        name: armName(variants, v?.id ?? key),
        role: key === "default" ? "control" : "test",
        weight: v?.weight ?? null,
        visitors: r.visitors[key],
        exposed: null,
        counts: { successes: goal?.[key] ?? 0, total: r.visitors[key] },
        purchases: null,
        revenue: null,
        behaviour: null,
        daily: [],
      };
    };
    return [side("default"), side("variant")];
  }
  const control = variants.find((v) => v.role === "control")?.id ?? arms[0]?.id;
  const treatment =
    variants.find((v) => v.role === "treatment")?.id ??
    arms.find((a) => a.id !== control)?.id;
  const onExposed = arms.some((a) => (a.exposed ?? 0) > 0);
  const counts = (a: {
    visitors: number;
    exposed: number | null;
    converters: number;
    convertersAmongExposed: number | null;
  }): ArmCounts =>
    onExposed
      ? { successes: a.convertersAmongExposed ?? 0, total: a.exposed ?? 0 }
      : { successes: a.converters, total: a.visitors };
  const rank = (id: string) => (id === control ? 0 : id === treatment ? 1 : 2);
  return [...arms]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((a) => ({
      id: a.id,
      name: armName(variants, a.id),
      role: a.id === control ? "control" : a.id === treatment ? "test" : null,
      weight: weight(a.id),
      visitors: a.visitors,
      exposed: a.exposed,
      counts: counts(a),
      purchases: a.purchases,
      revenue: a.revenue,
      behaviour: a.behaviour,
      daily: a.daily.map((d) => ({ date: d.date, counts: counts(d) })),
    }));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="surface overflow-hidden">
      <h3 className="border-b border-border px-4 py-3 text-sm font-medium text-foreground">
        {title}
      </h3>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/** A column header that explains itself on hover. */
function Head({
  label,
  hint,
  left,
}: {
  label: string;
  hint?: string;
  left?: boolean;
}) {
  const className = cn("whitespace-nowrap", !left && "text-right");
  if (!hint) return <TableHead className={className}>{label}</TableHead>;
  return (
    <TableHead className={className}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{hint}</TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

function ArmName({ arm }: { arm: ArmView }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <span className="font-medium">{arm.name}</span>
      {arm.name !== arm.id && (
        <span className="font-mono text-xs text-muted-foreground">
          {arm.id}
        </span>
      )}
      {arm.role && (
        <Badge variant={arm.role === "control" ? "outline" : "secondary"}>
          {t(
            arm.role === "control"
              ? "experiments.results.control"
              : "experiments.results.test",
          )}
        </Badge>
      )}
      {arm.weight !== null && (
        <span className="text-xs text-muted-foreground">
          {t("experiments.results.weight", { weight: arm.weight })}
        </span>
      )}
    </div>
  );
}

/** Marks a spot in a translated string for a node, so a glossary term can sit
 *  anywhere the translation puts it. */
const SLOT = "\u0001";
const slot = (name: string) => `${SLOT}${name}${SLOT}`;
function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text
    .split(SLOT)
    .map((part, i) =>
      i % 2 === 1 ? <Fragment key={part}>{nodes[part]}</Fragment> : part,
    );
}

/** A word the glossary explains on hover or focus. */
function Term({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the definition for keyboard readers */}
        <span
          tabIndex={0}
          className="cursor-help underline decoration-muted-foreground/60 decoration-dotted underline-offset-4"
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{hint}</TooltipContent>
    </Tooltip>
  );
}

function useTerms() {
  const t = useT();
  return {
    significant: (
      <Term
        label={t("experiments.results.glossary.significant")}
        hint={t("experiments.results.glossary.significantHint")}
      />
    ),
    exposed: (
      <Term
        label={t("experiments.results.glossary.exposed")}
        hint={t("experiments.results.glossary.exposedHint")}
      />
    ),
    margin: (
      <Term
        label={t("experiments.results.glossary.margin")}
        hint={t("experiments.results.glossary.marginHint")}
      />
    ),
  };
}

/** A chance as a whole percent, never a flat 0% or 100%. */
function chance(x: number, t: TFunction): string {
  if (x >= 0.995) return t("experiments.results.chanceAbove");
  if (x < 0.005) return t("experiments.results.chanceBelow");
  return pct(x, 0);
}

/** A lift's size in words: 0.34 below zero reads "34%" with "pior" after it. */
const size = (x: number) => pct(Math.abs(x), 0);

/** A 1px vertical dashed rule, drawn so it reads on both themes. */
const DASHED =
  "repeating-linear-gradient(to bottom, var(--muted-foreground) 0 4px, transparent 4px 7px)";

/** The margins the forecast walks down to, widest first. */
const MARGIN_TARGETS = [0.1, 0.05, 0.02];

const BAR_TONE: Record<Verdict, string> = {
  few: "bg-muted-foreground",
  unclear: "bg-foreground",
  notWorse: "bg-foreground",
  better: "bg-success",
  worse: "bg-destructive",
};

/**
 * Where the real difference probably is: the measured lift on a line from
 * worse to better, its 95% range, zero and the −2% line the test must clear to
 * grow. The page's single most important picture.
 */
function LiftRange({
  c,
  test,
  control,
}: {
  c: Comparison;
  test: string;
  control: string;
}) {
  const t = useT();
  if (c.lift === null || c.low === null || c.high === null) return null;
  const { lift, low, high } = c;
  const axis = liftAxis([low, high]);
  const at = (v: number) => ((v - axis.min) / (axis.max - axis.min)) * 100;
  const narrow = at(high) - at(low) < 22;
  const zeroTick = axis.ticks.indexOf(0);
  const range = t("experiments.results.range", {
    low: signedPct(low, 0),
    high: signedPct(high, 0),
  });
  return (
    <figure
      className="flex flex-col gap-1.5"
      aria-label={t("experiments.results.chart.aria", {
        test,
        control,
        lift: signedPct(lift),
        range,
      })}
    >
      <div className="relative h-24 select-none">
        <div
          className="absolute inset-y-0 left-0 rounded-l-md"
          style={{
            width: `${at(0)}%`,
            background:
              "color-mix(in oklch, var(--destructive) 7%, transparent)",
          }}
        />
        <div
          className="absolute inset-y-0 right-0 rounded-r-md"
          style={{
            left: `${at(0)}%`,
            background: "color-mix(in oklch, var(--success) 7%, transparent)",
          }}
        />
        <span className="absolute top-2 left-2.5 text-xs text-muted-foreground">
          {t("experiments.results.chart.worse")}
        </span>
        <span className="absolute top-2 right-2.5 text-xs text-muted-foreground">
          {t("experiments.results.chart.better")}
        </span>
        <div
          className="absolute inset-y-0 w-px -translate-x-1/2"
          style={{ left: `${at(NON_INFERIORITY)}%`, background: DASHED }}
        />
        <span
          className="absolute bottom-1.5 -translate-x-full pr-1.5 text-xs tabular-nums text-muted-foreground"
          style={{ left: `${at(NON_INFERIORITY)}%` }}
        >
          {signedPct(NON_INFERIORITY, 0)}
        </span>
        <div
          className="absolute inset-y-0 w-px -translate-x-1/2"
          style={{
            left: `${at(0)}%`,
            background: "var(--foreground)",
            opacity: 0.5,
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={range}
              className="absolute top-1/2 h-6 -translate-y-1/2 cursor-help rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: `${at(low)}%`, width: `${at(high) - at(low)}%` }}
            >
              <span
                className={cn(
                  "absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full",
                  BAR_TONE[c.verdict],
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            {t("experiments.results.chart.tooltip", {
              lift: signedPct(lift),
              range,
            })}
          </TooltipContent>
        </Tooltip>
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
            BAR_TONE[c.verdict],
          )}
          style={{ left: `${at(lift)}%` }}
        />
        <span
          className="absolute top-[calc(50%-1.75rem)] -translate-x-1/2 text-sm font-semibold tabular-nums text-foreground"
          style={{ left: `${at(lift)}%` }}
        >
          {signedPct(lift)}
        </span>
        {narrow ? (
          <span
            className="absolute top-[calc(50%+0.75rem)] -translate-x-1/2 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
            style={{ left: `${at(lift)}%` }}
          >
            {range}
          </span>
        ) : (
          <>
            <span
              className="absolute top-[calc(50%+0.75rem)] text-xs tabular-nums text-muted-foreground"
              style={{ left: `${at(low)}%` }}
            >
              {signedPct(low, 0)}
            </span>
            <span
              className="absolute top-[calc(50%+0.75rem)] -translate-x-full text-xs tabular-nums text-muted-foreground"
              style={{ left: `${at(high)}%` }}
            >
              {signedPct(high, 0)}
            </span>
          </>
        )}
      </div>
      <div className="relative h-4 text-xs tabular-nums text-muted-foreground">
        {axis.ticks.map((tick, i) => (
          <span
            key={tick}
            className={cn(
              "absolute",
              // On a phone every other tick, counted from zero, so zero stays.
              (i - zeroTick) % 2 !== 0 && "max-sm:hidden",
              i === 0
                ? ""
                : i === axis.ticks.length - 1
                  ? "-translate-x-full"
                  : "-translate-x-1/2",
            )}
            style={{ left: `${at(tick)}%` }}
          >
            {signedPct(tick, 0)}
          </span>
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-full", BAR_TONE[c.verdict])} />
          {t("experiments.results.chart.measured")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn("h-1.5 w-4 rounded-full", BAR_TONE[c.verdict])} />
          {t("experiments.results.chart.range")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-px" style={{ background: DASHED }} />
          {t("experiments.results.chart.bar", {
            bar: signedPct(NON_INFERIORITY, 0),
          })}
        </span>
      </figcaption>
    </figure>
  );
}

/** One fact under the verdict: a question on the left, its answer on the right. */
function Fact({
  label,
  value,
  note,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold tabular-nums text-foreground">
        {value}
      </dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

/** Why early numbers swing and why one day never decides. */
function HowToRead() {
  const t = useT();
  return (
    <details className="group rounded-md border border-border px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none font-medium text-foreground outline-none focus-visible:underline">
        {t("experiments.results.howTo.title")}
      </summary>
      <div className="flex max-w-3xl flex-col gap-2 pt-3 text-muted-foreground">
        <p>{t("experiments.results.howTo.range")}</p>
        <p>{t("experiments.results.howTo.early")}</p>
        <p>{t("experiments.results.howTo.looks")}</p>
        <p>{t("experiments.results.howTo.calendar")}</p>
        <dl className="grid gap-x-4 gap-y-1.5 pt-1 sm:grid-cols-[max-content_1fr]">
          {(["margin", "significant", "exposed"] as const).map((term) => (
            <Fragment key={term}>
              <dt className="font-medium text-foreground">
                {t(`experiments.results.glossary.${term}Title`)}
              </dt>
              <dd>{t(`experiments.results.glossary.${term}Hint`)}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="text-xs">
          {t("experiments.results.howTo.method", {
            deff: dec(DEFF),
            bar: signedPct(NON_INFERIORITY, 0),
          })}
        </p>
      </div>
    </details>
  );
}

function VerdictCard({
  control,
  test,
  exposure,
  days,
}: {
  control: ArmView;
  test: ArmView;
  exposure: boolean;
  days: number;
}) {
  const t = useT();
  const terms = useTerms();
  const c = compareArms(control.counts, test.counts);
  const names = { arm: test.name, test: test.name, control: control.name };
  const title =
    c.verdict === "few" || c.verdict === "unclear"
      ? t(`experiments.results.verdict.${c.verdict}`)
      : t(`experiments.results.verdict.${c.verdict}`, names);

  const lines: ReactNode[] = [];
  if (c.lift === null) {
    lines.push(t("experiments.results.verdict.noBase"));
  } else {
    lines.push(
      rich(
        t(
          exposure
            ? "experiments.results.verdict.compareExposed"
            : "experiments.results.verdict.compareVisitors",
          {
            ...names,
            testRate: pct(c.treatmentRate),
            controlRate: pct(c.controlRate),
            exposed: slot("exposed"),
          },
        ),
        terms,
      ),
    );
    if (c.verdict === "few") {
      lines.push(
        t("experiments.results.verdict.fewHint", {
          total: MIN_TOTAL,
          successes: MIN_SUCCESSES,
        }),
      );
    } else {
      const claim =
        c.verdict === "better"
          ? "experiments.results.claim.better"
          : c.verdict === "worse"
            ? "experiments.results.claim.worse"
            : c.verdict === "notWorse"
              ? "experiments.results.claim.notWorse"
              : c.lift < 0
                ? "experiments.results.claim.lower"
                : c.lift > 0
                  ? "experiments.results.claim.higher"
                  : "experiments.results.claim.even";
      lines.push(
        rich(
          t(claim, {
            ...names,
            significant: slot("significant"),
            bar: size(NON_INFERIORITY),
          }),
          terms,
        ),
      );
    }
    if (c.low !== null && c.high !== null) {
      lines.push(
        c.low < 0 && c.high > 0
          ? t("experiments.results.range.cross", {
              low: size(c.low),
              high: size(c.high),
            })
          : c.low >= 0
            ? t("experiments.results.range.above", {
                near: size(c.low),
                far: size(c.high),
              })
            : t("experiments.results.range.below", {
                near: size(c.high),
                far: size(c.low),
              }),
      );
    }
  }

  const margin = c.margin;
  const target =
    margin === null ? undefined : MARGIN_TARGETS.find((m) => m < margin);
  const forecast =
    target === undefined
      ? null
      : daysToMargin(control.counts, test.counts, days, target);
  const decided = c.verdict !== "few" && c.pBetter !== null;

  const progress = [
    days > 0 &&
      t(
        days === 1
          ? "experiments.results.progress.runningOne"
          : "experiments.results.progress.running",
        { days },
      ),
    forecast &&
      target !== undefined &&
      forecast.evenSplitDays < forecast.days &&
      t(
        forecast.evenSplitDays === 1
          ? "experiments.results.progress.evenSplitOne"
          : "experiments.results.progress.evenSplit",
        { days: num(forecast.evenSplitDays), margin: pct(target, 0) },
      ),
  ].filter(Boolean);

  return (
    <section className="surface flex flex-col gap-5 p-5 md:p-6">
      <div className="flex flex-col gap-2">
        <h3
          className={cn(
            "text-2xl font-semibold text-balance",
            VERDICT_TONE[c.verdict],
          )}
        >
          {title}
        </h3>
        <p className="max-w-3xl text-sm leading-relaxed text-foreground">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed order of sentences
            <Fragment key={i}>
              {i > 0 && " "}
              {line}
            </Fragment>
          ))}
        </p>
      </div>
      <LiftRange c={c} test={test.name} control={control.name} />
      <dl className="grid gap-x-8 sm:grid-cols-2">
        {decided && c.pBetter !== null && c.pBetterTarget !== null && (
          <>
            <Fact
              label={t("experiments.results.fact.better", names)}
              value={chance(c.pBetter, t)}
            />
            <Fact
              label={t("experiments.results.fact.target", {
                target: pct(TARGET_LIFT, 0),
              })}
              value={chance(c.pBetterTarget, t)}
            />
          </>
        )}
        {decided && c.safety && c.notWorseAt !== null && (
          <Fact
            label={t("experiments.results.fact.safety", {
              bar: signedPct(NON_INFERIORITY, 0),
            })}
            value={t(`experiments.results.safety.${c.safety}`)}
            note={
              c.safety === "open"
                ? t("experiments.results.safety.openNote", {
                    bar: signedPct(c.notWorseAt),
                  })
                : undefined
            }
          />
        )}
        {margin !== null && (
          <Fact
            label={terms.margin}
            value={`±${pct(margin, 0)}`}
            note={
              target === undefined
                ? undefined
                : forecast === null
                  ? t("experiments.results.forecast.unknown")
                  : forecast.days === 0
                    ? t("experiments.results.forecast.reached", {
                        margin: pct(target, 0),
                      })
                    : t(
                        forecast.days === 1
                          ? "experiments.results.forecast.leftOne"
                          : "experiments.results.forecast.left",
                        {
                          margin: pct(target, 0),
                          days: num(forecast.days),
                          exposed: num(forecast.exposed),
                        },
                      )
            }
          />
        )}
      </dl>
      {progress.length > 0 && (
        <p className="text-xs text-muted-foreground">{progress.join(" ")}</p>
      )}
      <HowToRead />
    </section>
  );
}

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });

/** The lift with every day so far added up: early swings and a range that
 *  narrows as days come in, so one day is never read as the answer. */
function LiftTrend({ control, test }: { control: ArmView; test: ArmView }) {
  const t = useT();
  const points = cumulativeLift(control.daily, test.daily).filter(
    (p) => p.lift !== null && p.low !== null && p.high !== null,
  );
  if (points.length < 2) return null;
  const axis = liftAxis(points.flatMap((p) => [p.low ?? 0, p.high ?? 0]));
  const data = points.map((p) => ({
    label: dayLabel(p.date),
    lift: p.lift,
    band: [p.low, p.high],
  }));
  const config = {
    lift: {
      label: t("experiments.results.chart.measured"),
      color: "var(--chart-1)",
    },
    band: {
      label: t("experiments.results.chart.range"),
      color: "var(--chart-1)",
    },
  };
  return (
    <Section title={t("experiments.results.liftTrend")}>
      <div className="flex flex-col gap-3 p-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("experiments.results.liftTrendHint")}
        </p>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="h-0.5 w-4 rounded-full"
              style={{ background: "var(--chart-1)" }}
            />
            {t("experiments.results.chart.measuredTotal")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-3 w-4 rounded-sm"
              style={{
                background:
                  "color-mix(in oklch, var(--chart-1) 25%, transparent)",
              }}
            />
            {t("experiments.results.chart.range")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-px" style={{ background: DASHED }} />
            {t("experiments.results.chart.bar", {
              bar: signedPct(NON_INFERIORITY, 0),
            })}
          </span>
        </div>
        <ChartContainer config={config} className="aspect-auto h-60 w-full">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="4 4" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              padding={{ left: 16, right: 16 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={52}
              ticks={axis.ticks}
              domain={[axis.min, axis.max]}
              tickFormatter={(v: number) => signedPct(v, 0)}
            />
            <ReferenceLine
              y={0}
              stroke="var(--foreground)"
              strokeOpacity={0.45}
            />
            <ReferenceLine
              y={NON_INFERIORITY}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
            />
            <ChartTooltip
              content={({ active, payload, label }) => {
                const p = payload?.[0]?.payload as
                  | (typeof data)[number]
                  | undefined;
                if (!active || !p || p.lift === null) return null;
                return (
                  <div className="surface flex flex-col gap-0.5 px-3 py-2 text-xs shadow-md">
                    <span className="font-medium text-foreground">{label}</span>
                    <span className="tabular-nums text-foreground">
                      {t("experiments.results.chart.tooltipDay", {
                        lift: signedPct(p.lift),
                      })}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {t("experiments.results.range", {
                        low: signedPct(p.band[0] ?? 0, 0),
                        high: signedPct(p.band[1] ?? 0, 0),
                      })}
                    </span>
                  </div>
                );
              }}
            />
            <Area
              dataKey="band"
              type="monotone"
              stroke="none"
              fill="var(--chart-1)"
              fillOpacity={0.18}
              isAnimationActive={false}
            />
            <Line
              dataKey="lift"
              type="monotone"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartContainer>
      </div>
    </Section>
  );
}

function ArmsTable({
  arms,
  exposure,
  goal,
  currency,
}: {
  arms: ArmView[];
  exposure: boolean;
  goal: string;
  currency: string;
}) {
  const t = useT();
  const control = arms.find((a) => a.role === "control");
  const hasMoney = arms.some((a) => a.revenue !== null);
  const dash = <span className="text-muted-foreground">—</span>;
  return (
    <Section title={t("experiments.results.armsTitle")}>
      <Table variant="flush">
        <TableHeader>
          <TableRow>
            <Head left label={t("experiments.results.arm")} />
            <Head
              label={t("experiments.results.visitors")}
              hint={t("experiments.results.visitorsHint")}
            />
            {exposure && (
              <Head
                label={t("experiments.results.exposed")}
                hint={t("experiments.results.exposedHint")}
              />
            )}
            <Head
              label={t("experiments.results.conversion")}
              hint={t(
                exposure
                  ? "experiments.results.conversionHintExposed"
                  : "experiments.results.conversionHintVisitors",
                { goal: goalLabel(goal, t) },
              )}
            />
            <Head
              label={t("experiments.results.difference")}
              hint={t("experiments.results.differenceHint")}
            />
            {hasMoney && (
              <>
                <Head label={t("experiments.results.orders")} />
                <Head label={t("experiments.results.revenue")} />
                <Head label={t("experiments.results.revenuePerVisitor")} />
                <Head label={t("experiments.results.averageOrder")} />
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {arms.map((a) => {
            const vs =
              control && a !== control
                ? compareArms(control.counts, a.counts)
                : null;
            const perVisitor = ratio(a.revenue, a.visitors);
            const perOrder = ratio(a.revenue, a.purchases);
            return (
              <TableRow key={a.id}>
                <TableCell>
                  <ArmName arm={a} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(a.visitors)}
                </TableCell>
                {exposure && (
                  <TableCell className="text-right tabular-nums">
                    {num(a.exposed ?? 0)}
                  </TableCell>
                )}
                <TableCell className="text-right font-semibold tabular-nums">
                  {a.counts.total > 0
                    ? pct(a.counts.successes / a.counts.total)
                    : dash}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {!vs ? (
                    <span className="text-xs text-muted-foreground">
                      {t("experiments.results.reference")}
                    </span>
                  ) : vs.lift === null ||
                    vs.low === null ||
                    vs.high === null ? (
                    dash
                  ) : (
                    <div className="flex flex-col items-end">
                      <span
                        className={cn("font-medium", VERDICT_TONE[vs.verdict])}
                      >
                        {signedPct(vs.lift)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("experiments.results.range", {
                          low: signedPct(vs.low, 0),
                          high: signedPct(vs.high, 0),
                        })}
                      </span>
                    </div>
                  )}
                </TableCell>
                {hasMoney && (
                  <>
                    <TableCell className="text-right tabular-nums">
                      {a.purchases === null ? dash : num(a.purchases)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {a.revenue === null ? dash : money(a.revenue, currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {perVisitor === null ? dash : money(perVisitor, currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {perOrder === null ? dash : money(perOrder, currency)}
                    </TableCell>
                  </>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

/** The decision metric per day and arm, once there are two days to join. */
function Trend({ arms }: { arms: ArmView[] }) {
  const t = useT();
  const dates = [
    ...new Set(arms.flatMap((a) => a.daily.map((d) => d.date))),
  ].sort();
  if (dates.length < 2) return null;
  const data = dates.map((date) => {
    const point: Record<string, string | number | null> = {
      label: new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "2-digit",
        timeZone: "UTC",
      }),
    };
    for (const a of arms) {
      const d = a.daily.find((x) => x.date === date);
      point[a.id] =
        d && d.counts.total > 0 ? d.counts.successes / d.counts.total : null;
    }
    return point;
  });
  // Round ticks (0, 10%, 20%…) rather than the axis's own thirds of the top.
  const top = Math.max(
    0,
    ...data.flatMap((p) => arms.map((a) => Number(p[a.id]) || 0)),
  );
  const step =
    [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25].find(
      (x) => top / x <= 4,
    ) ?? 0.25;
  const ticks = Array.from(
    { length: Math.ceil(top / step) + 1 },
    (_, i) => i * step,
  );
  const config = Object.fromEntries(
    arms.map((a, i) => [
      a.id,
      { label: a.name, color: `var(--chart-${(i % 5) + 1})` },
    ]),
  );
  return (
    <Section title={t("experiments.results.trend")}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          {arms.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: config[a.id]?.color }}
              />
              {a.name}
            </span>
          ))}
        </div>
        <ChartContainer config={config} className="h-56 w-full">
          <LineChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="4 4" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              padding={{ left: 16, right: 16 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              ticks={ticks}
              domain={[0, ticks.at(-1) ?? 1]}
              tickFormatter={(v: number) => pct(v, step < 0.01 ? 1 : 0)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(v, name) =>
                    `${config[String(name)]?.label ?? name} ${pct(Number(v))}`
                  }
                />
              }
            />
            {arms.map((a) => (
              <Line
                key={a.id}
                dataKey={a.id}
                type="monotone"
                stroke={config[a.id]?.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </div>
    </Section>
  );
}

function BehaviourTable({ arms }: { arms: ArmView[] }) {
  const t = useT();
  const rows = arms.filter(
    (a): a is ArmView & { behaviour: Behaviour } => a.behaviour !== null,
  );
  if (rows.length === 0) return null;
  return (
    <Section title={t("experiments.results.behaviour")}>
      <Table variant="flush">
        <TableHeader>
          <TableRow>
            <Head left label={t("experiments.results.arm")} />
            <Head
              label={t("experiments.results.pageviews")}
              hint={t("experiments.results.pageviewsHint")}
            />
            <Head
              label={t("experiments.results.activeTime")}
              hint={t("experiments.results.activeTimeHint")}
            />
            <Head
              label={t("experiments.results.clicks")}
              hint={t("experiments.results.clicksHint")}
            />
            <Head
              label={t("experiments.results.scroll")}
              hint={t("experiments.results.scrollHint")}
            />
            <Head
              label={t("experiments.results.jsErrors")}
              hint={t("experiments.results.jsErrorsHint")}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ id, name, behaviour: b }) => (
            <TableRow key={id}>
              <TableCell className="font-medium">{name}</TableCell>
              <TableCell className="text-right tabular-nums">
                {dec(b.pageviewsPerVisitor)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums">
                {duration(b.activeSecondsPerVisitor, t)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {dec(b.clicksPerVisitor)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {pct(b.medianScrollDepth / 100)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {pct(b.errorPct / 100)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function GoalsTable({
  goals,
  control,
  test,
}: {
  goals: ResultsBody["goals"];
  control: string;
  test: string;
}) {
  const t = useT();
  const rows = goals.filter((g) => g.goal !== "visitors");
  if (rows.length === 0) return null;
  return (
    <Section title={t("experiments.results.goals")}>
      <Table variant="flush">
        <TableHeader>
          <TableRow>
            <Head
              left
              label={t("experiments.results.goal")}
              hint={t("experiments.results.goalsHint")}
            />
            <Head label={control} />
            <Head label={test} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((g) => (
            <TableRow key={g.goal}>
              <TableCell>{goalLabel(g.goal, t)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {num(g.default)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {num(g.variant)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function ResultsView({
  data,
  experiment,
}: {
  data: ResultsData | undefined;
  experiment: Experiment;
}) {
  const t = useT();
  const now = useClockTick(3_600_000);
  if (!data?.available) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        {data?.reason === "no_site_data"
          ? t("experiments.results.noSiteData", { site: data.analyticsSite })
          : t("experiments.results.unavailable")}
      </div>
    );
  }

  const r = data.results;
  if (!r || r.stats.totalParticipants === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        {t("experiments.results.empty")}
      </div>
    );
  }

  const arms = toArms(r, experiment.variants);
  const control = arms.find((a) => a.role === "control");
  const test = arms.find((a) => a.role === "test");
  const exposure = arms.some((a) => a.exposed !== null);
  const days =
    daysRunning(experiment.startedAt, now) ||
    new Set(arms.flatMap((a) => a.daily.map((d) => d.date))).size;
  const goal =
    r.statsGoal ?? r.goals.find((g) => g.goal !== "visitors")?.goal ?? "";

  return (
    <div className="flex flex-col gap-4">
      {control && test && (
        <VerdictCard
          control={control}
          test={test}
          exposure={exposure && arms.some((a) => (a.exposed ?? 0) > 0)}
          days={days}
        />
      )}
      <ArmsTable
        arms={arms}
        exposure={exposure}
        goal={goal}
        currency={r.currency ?? "BRL"}
      />
      {control && test && <LiftTrend control={control} test={test} />}
      <Trend arms={arms} />
      <BehaviourTable arms={arms} />
      <GoalsTable
        goals={r.goals}
        control={control?.name ?? t("experiments.results.control")}
        test={test?.name ?? t("experiments.results.variant")}
      />
      {data.source === "deco-analytics" && (
        <span className="text-xs text-muted-foreground">
          {t("experiments.results.sourceDeco")}
        </span>
      )}
    </div>
  );
}

function Results({
  site,
  experiment,
}: {
  site: string;
  experiment: Experiment;
}) {
  const { data, isLoading } = useExperimentResults(site, experiment.key);
  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  return <ResultsView data={data} experiment={experiment} />;
}

function Detail({
  site,
  experiment,
  onBack,
}: {
  site: string;
  experiment: Experiment;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("experiments.action.back")}
        </Button>
        <span className="text-lg font-semibold">{experiment.name}</span>
        <Badge>{t(STATUS_LABELS[experiment.status])}</Badge>
      </div>
      <div className="rounded-lg border border-border p-4">
        <div className="mb-2 text-xs text-muted-foreground">
          {t("experiments.col.variants")}
        </div>
        <Variants variants={experiment.variants} />
      </div>
      <div className="text-sm font-semibold">
        {t("experiments.results.title")}
      </div>
      <Results site={site} experiment={experiment} />
    </div>
  );
}

export function LegacyExperimentsTab({
  virtualMcpId,
}: {
  virtualMcpId: string;
}) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: experiments, isLoading } = useExperiments(siteSlug ?? "");
  const update = useUpdateExperiment(siteSlug ?? "");
  const del = useDeleteExperiment(siteSlug ?? "");

  if (!siteSlug) {
    return (
      <div className="p-8">
        <EmptyState
          title={t("experiments.title")}
          description={t("experiments.noSite")}
        />
      </div>
    );
  }

  const selected = experiments?.find((e) => e.key === selectedKey) ?? null;
  if (selected) {
    return (
      <Detail
        site={siteSlug}
        experiment={selected}
        onBack={() => setSelectedKey(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("experiments.title")}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("experiments.subtitle")}
          </p>
        </div>
        {experiments && experiments.length > 0 && (
          <Button onClick={() => setDialogOpen(true)}>
            {t("experiments.new")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Spinner />
        </div>
      ) : !experiments || experiments.length === 0 ? (
        <EmptyState
          title={t("experiments.empty.title")}
          description={t("experiments.empty.desc")}
          buttonProps={{
            children: t("experiments.new"),
            onClick: () => setDialogOpen(true),
          }}
        />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("experiments.col.name")}</TableHead>
                <TableHead>{t("experiments.col.key")}</TableHead>
                <TableHead>{t("experiments.col.status")}</TableHead>
                <TableHead>{t("experiments.col.variants")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiments.map((e) => (
                <TableRow key={e.key}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-sm underline-offset-4 hover:underline"
                      onClick={() => setSelectedKey(e.key)}
                    >
                      {e.name}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.key}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={e.status}
                      onValueChange={(v) =>
                        update.mutate({
                          key: e.key,
                          status: v as ExperimentStatus,
                        })
                      }
                    >
                      <SelectTrigger size="sm" className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {t(STATUS_LABELS[s])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Variants variants={e.variants} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (
                          window.confirm(
                            t("experiments.deleteConfirm", { key: e.key }),
                          )
                        ) {
                          del.mutate(e.key);
                        }
                      }}
                    >
                      {t("experiments.action.delete")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateDialog
        site={siteSlug}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
