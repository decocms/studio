/**
 * Core Web Vitals: Google's assessment, each metric's p75 and its share of
 * good / needs-work / poor loads, then the splits no speed tool has because
 * they need the variant and the purchase on the same row: vitals per
 * experiment arm and conversion by landing speed.
 */

import { Speedometer02 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { TrendChart } from "./charts";
import {
  capitalize,
  type Column,
  FilterKey,
  firstRow,
  fmtInt,
  fmtMs,
  fmtPct,
  Group,
  n0,
  num,
  Panel,
  PanelTable,
  type Row,
  ratioPct,
  rowsOf,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  str,
  useSectionView,
} from "./panels";
import {
  type Assessment,
  assess,
  asBand,
  type Band,
  BANDS,
  type BandCounts,
  bandCounts,
  bandOf,
  CORE_VITALS,
  VITAL_META,
  VITALS,
  type Vital,
} from "./vitals-model";
import type { SectionProps } from "./types";

const BAND_BG: Record<Band, string> = {
  good: "bg-success",
  "needs work": "bg-warning",
  poor: "bg-destructive",
};

function bandLabel(band: Band, t: TFunction): string {
  switch (band) {
    case "good":
      return t("monitor.analytics.panels.vitals.good");
    case "needs work":
      return t("monitor.analytics.panels.vitals.needsWork");
    case "poor":
      return t("monitor.analytics.panels.vitals.poor");
    default: {
      const never: never = band;
      return never;
    }
  }
}

function vitalName(vital: Vital, t: TFunction): string {
  switch (vital) {
    case "lcp":
      return t("monitor.analytics.panels.vitals.lcp");
    case "inp":
      return t("monitor.analytics.panels.vitals.inp");
    case "cls":
      return t("monitor.analytics.panels.vitals.cls");
    case "ttfb":
      return t("monitor.analytics.panels.vitals.ttfb");
    case "fcp":
      return t("monitor.analytics.panels.vitals.fcp");
    default: {
      const never: never = vital;
      return never;
    }
  }
}

function fmtVital(vital: Vital, v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  return VITAL_META[vital].unit === "ms"
    ? fmtMs(n)
    : new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      }).format(n);
}

/** A value in its band's tone: a badge when it decides something. */
function BandValue({ vital, value }: { vital: Vital; value: unknown }) {
  const band = bandOf(vital, num(value));
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {band && <span className={cn("size-1.5 rounded-full", BAND_BG[band])} />}
      {fmtVital(vital, value)}
    </span>
  );
}

function AssessmentBadge({ verdict }: { verdict: Assessment }) {
  const t = useT();
  switch (verdict) {
    case "passing":
      return (
        <Badge variant="success" size="lg">
          {t("monitor.analytics.panels.vitals.passing")}
        </Badge>
      );
    case "failing":
      return (
        <Badge variant="destructive" size="lg">
          {t("monitor.analytics.panels.vitals.failing")}
        </Badge>
      );
    case "incomplete":
      return (
        <Badge variant="warning" size="lg">
          {t("monitor.analytics.panels.vitals.incomplete")}
        </Badge>
      );
    default: {
      const never: never = verdict;
      return never;
    }
  }
}

function BandBar({ counts }: { counts: BandCounts }) {
  const t = useT();
  const total = BANDS.reduce((a, b) => a + counts[b], 0);
  if (!total) {
    return (
      <span className="text-meta">
        {t("monitor.analytics.panels.vitals.noSamples")}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {BANDS.map((b) =>
          counts[b] ? (
            <div
              key={b}
              className={BAND_BG[b]}
              style={{ width: `${(100 * counts[b]) / total}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="text-meta tnum flex flex-wrap gap-x-3 gap-y-1">
        {BANDS.map((b) => (
          <span key={b} className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", BAND_BG[b])} />
            {bandLabel(b, t)} {fmtPct((100 * counts[b]) / total, 0)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function VitalsSection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "vitals");
  if (view.isLoading) return <SectionSkeleton tiles={5} />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;
  const v = firstRow(data, "vitals");
  if (!v || !n0(v.samples)) {
    return (
      <SectionEmpty
        icon={<Speedometer02 size={20} />}
        title={t("monitor.analytics.panels.vitals.empty")}
        description={t("monitor.analytics.panels.vitals.emptyDesc")}
      />
    );
  }

  const p75 = Object.fromEntries(
    VITALS.map((k) => [k, num(v[`${k}_p75`])]),
  ) as Record<Vital, number | null>;
  const { verdict } = assess(p75);
  const bands = bandCounts(
    rowsOf(data, "vitalsBands").map((r) => ({
      metric: r.metric,
      band: r.band,
      n: r.n,
    })),
  );
  const trend = rowsOf(data, "vitalsTrend");

  return (
    <>
      <Panel
        title={t("monitor.analytics.panels.vitals.assessment")}
        aside={
          <span className="text-meta tnum">
            {t("monitor.analytics.panels.vitals.loads", {
              n: fmtInt(v.samples),
            })}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <AssessmentBadge verdict={verdict} />
          <div className="flex flex-wrap gap-2">
            {CORE_VITALS.map((k) => {
              const band = bandOf(k, p75[k]);
              return (
                <Badge key={k} variant="outline" className="gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      band ? BAND_BG[band] : "bg-muted-foreground/40",
                    )}
                  />
                  {VITAL_META[k].label}
                  <span className="tnum text-muted-foreground">
                    {fmtVital(k, p75[k])}
                  </span>
                </Badge>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {VITALS.map((k) => (
          <Panel
            key={k}
            title={VITAL_META[k].label}
            value={
              <span className="whitespace-nowrap">{fmtVital(k, p75[k])}</span>
            }
            caption={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="text-meta truncate">{vitalName(k, t)}</span>
                {!CORE_VITALS.includes(k) && (
                  <Badge variant="muted" size="sm">
                    {t("monitor.analytics.panels.vitals.supporting")}
                  </Badge>
                )}
              </span>
            }
          >
            <BandBar counts={bands[k]} />
          </Panel>
        ))}
      </div>

      {trend.length > 1 && (
        <Panel title={t("monitor.analytics.panels.vitals.trend")}>
          <TrendChart
            points={trend}
            metric="lcp"
            label={t("monitor.analytics.panels.vitals.lcpP75")}
            format={(n) => fmtMs(n)}
            thresholds={[
              { value: VITAL_META.lcp.good, tone: "warning" },
              { value: VITAL_META.lcp.poor, tone: "destructive" },
            ]}
          />
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ByDevice rows={rowsOf(data, "vitalsByDevice")} />
        <SlowestPages rows={rowsOf(data, "vitalsByPage")} />
      </div>

      <Group title={t("monitor.analytics.panels.vitals.business")}>
        <div className="grid gap-4 lg:grid-cols-2">
          <ByVariant rows={rowsOf(data, "vitalsByVariant")} />
          <BySpeed rows={rowsOf(data, "conversionBySpeed")} />
        </div>
      </Group>
    </>
  );
}

function ByDevice({ rows }: { rows: Row[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.col.device"),
      cell: (r) => <FilterKey>{capitalize(str(r.k))}</FilterKey>,
    },
    {
      id: "lcp",
      header: "LCP p75",
      numeric: true,
      cell: (r) => <BandValue vital="lcp" value={r.lcp} />,
    },
    {
      id: "inp",
      header: "INP p75",
      numeric: true,
      cell: (r) => <BandValue vital="inp" value={r.inp} />,
    },
    {
      id: "cls",
      header: "CLS p75",
      numeric: true,
      cell: (r) => <BandValue vital="cls" value={r.cls} />,
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.samples"),
      numeric: true,
      cell: (r) => fmtInt(r.n),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.vitals.byDevice")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => str(r.k)}
        filter={(r) => ({ d: "device", v: str(r.k) })}
      />
    </Panel>
  );
}

function SlowestPages({ rows }: { rows: Row[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.col.page"),
      className: "max-w-0 w-full",
      cell: (r) => <FilterKey>{str(r.k)}</FilterKey>,
    },
    {
      id: "lcp",
      header: "LCP p75",
      numeric: true,
      cell: (r) => <BandValue vital="lcp" value={r.lcp} />,
    },
    {
      id: "cls",
      header: "CLS p75",
      numeric: true,
      cell: (r) => <BandValue vital="cls" value={r.cls} />,
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.samples"),
      numeric: true,
      cell: (r) => fmtInt(r.measured ?? r.n),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.vitals.slowest")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => str(r.k)}
        filter={(r) => ({ d: "path", v: str(r.k) })}
      />
    </Panel>
  );
}

function ByVariant({ rows }: { rows: Row[] }) {
  const t = useT();
  const title = t("monitor.analytics.panels.vitals.byVariant");
  const columns: Column<Row>[] = [
    {
      id: "exp",
      header: t("monitor.analytics.panels.col.experiment"),
      cell: (r) => str(r.experiment),
    },
    {
      id: "variant",
      header: t("monitor.analytics.panels.exp.variant"),
      cell: (r) => (
        <FilterKey>
          <span className="font-mono text-xs">{str(r.variant)}</span>
        </FilterKey>
      ),
    },
    {
      id: "lcp",
      header: "LCP p75",
      numeric: true,
      cell: (r) => <BandValue vital="lcp" value={r.lcp} />,
    },
    {
      id: "cls",
      header: "CLS p75",
      numeric: true,
      cell: (r) => <BandValue vital="cls" value={r.cls} />,
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.samples"),
      numeric: true,
      cell: (r) => fmtInt(r.n),
    },
  ];
  return (
    <Panel title={title}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${str(r.experiment)}=${str(r.variant)}`}
        filter={(r) => ({
          d: "exp",
          v: `${str(r.experiment)}=${str(r.variant)}`,
        })}
      />
    </Panel>
  );
}

/** Visitors bucketed by their landing page's LCP, and how many of them bought. */
function BySpeed({ rows }: { rows: Row[] }) {
  const t = useT();
  const ordered = BANDS.flatMap((b) => {
    const r = rows.find((x) => asBand(x.k) === b);
    return r ? [{ band: b, row: r }] : [];
  });
  const columns: Column<{ band: Band; row: Row }>[] = [
    {
      id: "band",
      header: t("monitor.analytics.panels.vitals.lcpBand"),
      cell: ({ band }) => (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", BAND_BG[band])} />
          {bandLabel(band, t)}
        </span>
      ),
    },
    {
      id: "visitors",
      header: t("monitor.analytics.panels.col.visitors"),
      numeric: true,
      cell: ({ row }) => fmtInt(row.visitors),
    },
    {
      id: "converters",
      header: t("monitor.analytics.panels.col.converters"),
      numeric: true,
      cell: ({ row }) => fmtInt(row.converters),
    },
    {
      id: "cr",
      header: t("monitor.analytics.panels.col.conversion"),
      numeric: true,
      cell: ({ row }) =>
        fmtPct(ratioPct(n0(row.converters), n0(row.visitors)), 2),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.vitals.bySpeed")}>
      <PanelTable columns={columns} rows={ordered} rowKey={(r) => r.band} />
    </Panel>
  );
}
