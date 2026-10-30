/**
 * Experiments: per experiment, each variant's conversion-rate difference from
 * control with its 95% interval, and the numbers behind it. Analytics records
 * the variant a site declares; it never assigns one.
 */

import { Beaker02 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { useAnalyticsSegment } from "./segment";
import {
  type Column,
  fmtInt,
  fmtMoney,
  fmtPct,
  moneyOf,
  n0,
  num,
  Panel,
  PanelTable,
  rowsOf,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  str,
  useSectionView,
  WithheldBadge,
} from "./panels";
import { type AbResult, type AbState, abTest, controlIndex } from "./stats";
import type { SectionProps } from "./types";

interface Arm {
  variant: string;
  visitors: number;
  converters: number;
  cr: number | null;
  revenue: unknown;
  test: AbResult | null;
}

function stateBadge(state: AbState, t: TFunction) {
  switch (state) {
    case "win":
      return (
        <Badge variant="success">{t("monitor.analytics.panels.exp.win")}</Badge>
      );
    case "loss":
      return (
        <Badge variant="destructive">
          {t("monitor.analytics.panels.exp.loss")}
        </Badge>
      );
    case "inconclusive":
      return (
        <Badge variant="warning">
          {t("monitor.analytics.panels.exp.inconclusive")}
        </Badge>
      );
    case "none":
      return (
        <Badge variant="muted">{t("monitor.analytics.panels.exp.none")}</Badge>
      );
    default: {
      const never: never = state;
      return never;
    }
  }
}

const pp = (v: number) =>
  new Intl.NumberFormat(undefined, {
    signDisplay: "exceptZero",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(100 * v);

export function ExperimentsSection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "experiments");
  if (view.isLoading) return <SectionSkeleton />;
  if (view.error) return <SectionError error={view.error} />;
  const rows = rowsOf(view.data, "variants");
  if (rows.length === 0) {
    return (
      <SectionEmpty
        icon={<Beaker02 size={20} />}
        title={t("monitor.analytics.panels.exp.empty")}
        description={t("monitor.analytics.panels.exp.emptyDesc")}
      />
    );
  }
  const byExperiment = new Map<string, typeof rows>();
  for (const r of rows) {
    const name = str(r.experiment);
    byExperiment.set(name, [...(byExperiment.get(name) ?? []), r]);
  }
  const money = moneyOf(view.data);
  return (
    <>
      {[...byExperiment].map(([name, vs]) => {
        const ci = controlIndex(vs.map((v) => str(v.variant)));
        const control = vs[ci];
        const base = {
          visitors: n0(control?.visitors),
          converters: n0(control?.converters ?? control?.conv),
        };
        const arms: Arm[] = vs.map((v, i) => {
          const arm = {
            visitors: n0(v.visitors),
            converters: n0(v.converters ?? v.conv),
          };
          return {
            variant: str(v.variant),
            ...arm,
            cr: num(v.cr),
            revenue: v.revenue,
            test: i === ci ? null : abTest(base, arm),
          };
        });
        return <Experiment key={name} name={name} arms={arms} money={money} />;
      })}
    </>
  );
}

function Experiment({
  name,
  arms,
  money,
}: {
  name: string;
  arms: Arm[];
  money: { currency: string | null; hasRevenue: boolean };
}) {
  const t = useT();
  const { toggleFilter, hasFilter } = useAnalyticsSegment();
  const tested = arms.flatMap((a) => (a.test ? [a.test] : []));
  // Symmetric around zero, padded so the control line never sits on an edge.
  const reach =
    Math.max(
      0.005,
      ...tested.flatMap((x) => [Math.abs(x.ciLo ?? 0), Math.abs(x.ciHi ?? 0)]),
    ) * 1.15;
  const pos = (v: number) =>
    Math.max(0, Math.min(100, (100 * (v + reach)) / (2 * reach)));

  const columns: Column<Arm>[] = [
    {
      id: "variant",
      header: t("monitor.analytics.panels.exp.variant"),
      cell: (a) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs">{a.variant}</span>
          {!a.test && !/^(control|baseline)$/i.test(a.variant) && (
            <Badge variant="muted">
              {t("monitor.analytics.panels.exp.control")}
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: "visitors",
      header: t("monitor.analytics.panels.col.visitors"),
      numeric: true,
      cell: (a) => fmtInt(a.visitors),
    },
    {
      id: "converters",
      header: t("monitor.analytics.panels.col.converters"),
      numeric: true,
      cell: (a) => fmtInt(a.converters),
    },
    {
      id: "cr",
      header: t("monitor.analytics.panels.col.conversion"),
      numeric: true,
      cell: (a) => fmtPct(a.cr, 2),
    },
    {
      id: "lift",
      header: t("monitor.analytics.panels.exp.lift"),
      numeric: true,
      cell: (a) =>
        a.test?.lift == null
          ? "—"
          : `${a.test.lift >= 0 ? "+" : "−"}${fmtPct(Math.abs(100 * a.test.lift), 1)}`,
    },
    {
      id: "ci",
      header: t("monitor.analytics.panels.exp.ci"),
      numeric: true,
      className: "text-muted-foreground",
      cell: (a) =>
        a.test && a.test.ciLo !== null && a.test.ciHi !== null
          ? t("monitor.analytics.panels.exp.ciRange", {
              lo: pp(a.test.ciLo),
              hi: pp(a.test.ciHi),
            })
          : "—",
    },
    {
      id: "revenue",
      header: money.currency
        ? t("monitor.analytics.panels.col.revenueIn", {
            currency: money.currency,
          })
        : t("monitor.analytics.panels.col.revenue"),
      numeric: true,
      cell: (a) =>
        money.hasRevenue ? fmtMoney(a.revenue, money.currency) : "—",
    },
    {
      id: "segment",
      header: "",
      className: "w-px",
      cell: (a) => {
        const f = { d: "exp", op: "is", v: `${name}=${a.variant}` } as const;
        return (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 font-normal"
            onClick={() => toggleFilter(f)}
          >
            {hasFilter(f)
              ? t("monitor.analytics.panels.exp.clearSegment")
              : t("monitor.analytics.panels.exp.segment")}
          </Button>
        );
      },
    },
  ];

  return (
    <Panel
      title={name}
      aside={
        <WithheldBadge
          label={t("monitor.analytics.panels.exp.peeking")}
          tip={t("monitor.analytics.panels.exp.peekingTip")}
        />
      }
    >
      <div className="flex flex-col gap-2">
        {arms.map((a) => (
          <div
            key={a.variant}
            className="grid grid-cols-[8rem_minmax(0,1fr)_10rem] items-center gap-4"
          >
            <span className="truncate font-mono text-xs text-foreground">
              {a.variant}
            </span>
            <div className="surface-inset relative h-6 rounded-md">
              <div
                className="absolute inset-y-1 w-px bg-foreground/40"
                style={{ left: `${pos(0)}%` }}
              />
              {a.test && a.test.ciLo !== null && a.test.ciHi !== null ? (
                <>
                  <div
                    className={cn(
                      "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
                      a.test.state === "win" && "bg-success/40",
                      a.test.state === "loss" && "bg-destructive/40",
                      (a.test.state === "inconclusive" ||
                        a.test.state === "none") &&
                        "bg-muted-foreground/30",
                    )}
                    style={{
                      left: `${pos(a.test.ciLo)}%`,
                      width: `${Math.max(0.5, pos(a.test.ciHi) - pos(a.test.ciLo))}%`,
                    }}
                  />
                  <div
                    className={cn(
                      "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card",
                      a.test.state === "win" && "bg-success",
                      a.test.state === "loss" && "bg-destructive",
                      (a.test.state === "inconclusive" ||
                        a.test.state === "none") &&
                        "bg-muted-foreground",
                    )}
                    style={{ left: `${pos((a.test.ciLo + a.test.ciHi) / 2)}%` }}
                  />
                </>
              ) : (
                <div
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground/50"
                  style={{ left: `${pos(0)}%` }}
                />
              )}
            </div>
            <span className="flex justify-end">
              {a.test ? (
                stateBadge(a.test.state, t)
              ) : (
                <span className="text-meta">
                  {t("monitor.analytics.panels.exp.baseline", {
                    pct: fmtPct(a.cr, 2),
                  })}
                </span>
              )}
            </span>
          </div>
        ))}
        <div className="grid grid-cols-[8rem_minmax(0,1fr)_10rem] gap-4">
          <span />
          <span className="text-meta tnum flex justify-between">
            <span>
              {t("monitor.analytics.panels.exp.pp", { n: pp(-reach) })}
            </span>
            <span>{t("monitor.analytics.panels.exp.control")}</span>
            <span>
              {t("monitor.analytics.panels.exp.pp", { n: pp(reach) })}
            </span>
          </span>
          <span />
        </div>
      </div>
      <PanelTable columns={columns} rows={arms} rowKey={(a) => a.variant} />
    </Panel>
  );
}
