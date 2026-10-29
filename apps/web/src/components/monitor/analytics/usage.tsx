/**
 * Usage & limits, read from the collector's meter rather than from stored
 * events: the only place an event that was refused, rate limited, cut from a
 * batch or lost can be seen. Each cause is counted on its own and never added
 * up, because each asks for a different fix.
 */

import { InfoCircle } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { TrendChart } from "./charts";
import {
  type Column,
  firstRow,
  fmtBytes,
  fmtInt,
  fmtPct,
  n0,
  num,
  Panel,
  PanelTable,
  type Payload,
  type Row,
  ratioPct,
  rowsOf,
  SectionError,
  SectionSkeleton,
  str,
  useSectionView,
} from "./panels";
import type { SectionProps } from "./types";

const fmtDecimal = (n: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);

const CAUSES = [
  "events_rate_limited",
  "events_batch_overflow",
  "events_over_quota",
  "events_rejected",
  "events_lost",
] as const;
type Cause = (typeof CAUSES)[number];

type Whose = "sender" | "account" | "platform";

function causeWhose(cause: Cause): Whose {
  switch (cause) {
    case "events_rate_limited":
    case "events_batch_overflow":
    case "events_rejected":
      return "sender";
    case "events_over_quota":
      return "account";
    case "events_lost":
      return "platform";
    default: {
      const never: never = cause;
      return never;
    }
  }
}

function causeText(
  cause: Cause,
  t: TFunction,
): { label: string; remedy: string } {
  switch (cause) {
    case "events_rate_limited":
      return {
        label: t("monitor.analytics.panels.usage.cause.rateLimited"),
        remedy: t("monitor.analytics.panels.usage.cause.rateLimitedFix"),
      };
    case "events_batch_overflow":
      return {
        label: t("monitor.analytics.panels.usage.cause.batch"),
        remedy: t("monitor.analytics.panels.usage.cause.batchFix"),
      };
    case "events_over_quota":
      return {
        label: t("monitor.analytics.panels.usage.cause.quota"),
        remedy: t("monitor.analytics.panels.usage.cause.quotaFix"),
      };
    case "events_rejected":
      return {
        label: t("monitor.analytics.panels.usage.cause.rejected"),
        remedy: t("monitor.analytics.panels.usage.cause.rejectedFix"),
      };
    case "events_lost":
      return {
        label: t("monitor.analytics.panels.usage.cause.lost"),
        remedy: t("monitor.analytics.panels.usage.cause.lostFix"),
      };
    default: {
      const never: never = cause;
      return never;
    }
  }
}

function WhoseBadge({ whose }: { whose: Whose }) {
  const t = useT();
  switch (whose) {
    case "sender":
      return (
        <Badge variant="muted">
          {t("monitor.analytics.panels.usage.whose.sender")}
        </Badge>
      );
    case "account":
      return (
        <Badge variant="muted">
          {t("monitor.analytics.panels.usage.whose.account")}
        </Badge>
      );
    case "platform":
      return (
        <Badge variant="destructive">
          {t("monitor.analytics.panels.usage.whose.platform")}
        </Badge>
      );
    default: {
      const never: never = whose;
      return never;
    }
  }
}

/** The collector's enforced ceilings, when the payload carries them. */
function limitsOf(data: Payload | undefined): {
  eventsPerBatch: number | null;
  eventsPerVisitorPerMinute: number | null;
  requestBytes: number | null;
} | null {
  const worker = data?.worker;
  if (typeof worker !== "object" || worker === null || !("limits" in worker)) {
    return null;
  }
  const l = worker.limits;
  if (typeof l !== "object" || l === null) return null;
  const pick = (k: string) => (k in l ? num((l as Row)[k]) : null);
  return {
    eventsPerBatch: pick("eventsPerBatch"),
    eventsPerVisitorPerMinute: pick("eventsPerVisitorPerMinute"),
    requestBytes: pick("requestBytes"),
  };
}

export function UsageSection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "usage");
  if (view.isLoading) return <SectionSkeleton tiles={5} />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;

  const u = firstRow(data, "usage") ?? {};
  const accepted = n0(u.events_accepted);
  const requests = n0(u.requests);
  const drops = CAUSES.map((c) => ({ cause: c, events: n0(u[c]) }));
  const arrived = accepted + drops.reduce((a, d) => a + d.events, 0);
  const active = drops
    .filter((d) => d.events > 0)
    .sort((a, b) => b.events - a.events);
  const storedPct = ratioPct(accepted, arrived);
  const perRequest = requests ? accepted / requests : null;
  const recovered = n0(u.insert_recovered);
  const trend = rowsOf(data, "usageTrend");
  const sites = rowsOf(data, "usageSites");
  const limits = limitsOf(data);
  const quota = props.status.config?.quota;
  const capped = typeof quota === "number" && quota > 0;

  const tiles = [
    {
      key: "stored",
      title: t("monitor.analytics.panels.usage.stored"),
      value: fmtInt(accepted),
    },
    {
      key: "pct",
      title: t("monitor.analytics.panels.usage.ofSent"),
      value: fmtPct(storedPct, 2),
      caption: t("monitor.analytics.panels.usage.arrived", {
        n: fmtInt(arrived),
      }),
    },
    {
      key: "requests",
      title: t("monitor.analytics.panels.usage.requests"),
      value: fmtInt(requests),
    },
    {
      key: "perRequest",
      title: t("monitor.analytics.panels.usage.perRequest"),
      value: perRequest === null ? "—" : fmtDecimal(perRequest),
    },
    {
      key: "bytes",
      title: t("monitor.analytics.panels.usage.bytes"),
      value: fmtBytes(u.bytes_in),
    },
  ];

  const causeColumns: Column<{ cause: Cause; events: number }>[] = [
    {
      id: "cause",
      header: t("monitor.analytics.panels.usage.cause"),
      cell: ({ cause }) => {
        const { label, remedy } = causeText(cause, t);
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-default items-center gap-1.5">
                {label}
                <InfoCircle size={14} className="text-muted-foreground" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">{remedy}</TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      id: "whose",
      header: t("monitor.analytics.panels.usage.whose"),
      cell: ({ cause }) => <WhoseBadge whose={causeWhose(cause)} />,
    },
    {
      id: "events",
      header: t("monitor.analytics.panels.col.events"),
      numeric: true,
      cell: ({ events }) => fmtInt(events),
    },
    {
      id: "share",
      header: t("monitor.analytics.panels.usage.ofArrived"),
      numeric: true,
      className: "text-muted-foreground",
      cell: ({ events }) => fmtPct(ratioPct(events, arrived), 2),
    },
  ];

  const rateLimited = n0(u.events_rate_limited) > 0;
  const overBatch = n0(u.events_batch_overflow) > 0;
  const limitRows: {
    key: string;
    label: string;
    ceiling: string;
    now: string;
  }[] = [
    {
      key: "batch",
      label: t("monitor.analytics.panels.usage.limit.batch"),
      ceiling: fmtInt(limits?.eventsPerBatch),
      now: overBatch
        ? t("monitor.analytics.panels.usage.exceeded")
        : perRequest === null
          ? "—"
          : t("monitor.analytics.panels.usage.averaging", {
              n: fmtDecimal(perRequest),
            }),
    },
    {
      key: "rate",
      label: t("monitor.analytics.panels.usage.limit.rate"),
      ceiling: fmtInt(limits?.eventsPerVisitorPerMinute),
      now: rateLimited
        ? t("monitor.analytics.panels.usage.reached")
        : t("monitor.analytics.panels.usage.notReached"),
    },
    {
      key: "bytes",
      label: t("monitor.analytics.panels.usage.limit.bytes"),
      ceiling: fmtBytes(limits?.requestBytes),
      now: requests
        ? t("monitor.analytics.panels.usage.averaging", {
            n: fmtBytes(n0(u.bytes_in) / requests),
          })
        : "—",
    },
  ];
  const limitColumns: Column<(typeof limitRows)[number]>[] = [
    {
      id: "label",
      header: t("monitor.analytics.panels.usage.limit"),
      cell: (r) => r.label,
    },
    ...(limits
      ? [
          {
            id: "ceiling",
            header: t("monitor.analytics.panels.usage.ceiling"),
            numeric: true,
            cell: (r: (typeof limitRows)[number]) => r.ceiling,
          },
        ]
      : []),
    {
      id: "now",
      header: t("monitor.analytics.panels.usage.whereYouAre"),
      numeric: true,
      className: "text-muted-foreground",
      cell: (r) => r.now,
    },
  ];

  return (
    <>
      <section className="surface flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm text-foreground/70">
            {t("monitor.analytics.panels.usage.quota")}
          </h3>
          {props.status.config?.enabled === false && (
            <Badge variant="warning">
              {t("monitor.analytics.panels.usage.paused")}
            </Badge>
          )}
          <span className="tnum ml-auto text-sm font-medium text-foreground">
            {capped
              ? t("monitor.analytics.panels.usage.perMonth", {
                  n: fmtInt(quota),
                })
              : t("monitor.analytics.panels.usage.uncapped")}
          </span>
        </div>
        {capped && props.range === "30d" && (
          <div className="flex items-center gap-3">
            <div className="surface-inset h-2 flex-1 overflow-hidden rounded-full">
              <div
                className={cn(
                  "h-full",
                  accepted >= quota ? "bg-destructive" : "bg-chart-1",
                )}
                style={{
                  width: `${Math.min(100, (100 * accepted) / quota)}%`,
                }}
              />
            </div>
            <span className="text-meta tnum">
              {t("monitor.analytics.panels.usage.quotaUsed", {
                pct: fmtPct((100 * accepted) / quota, 0),
              })}
            </span>
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {tiles.map((tile) => (
          <Panel
            key={tile.key}
            title={tile.title}
            value={<span className="whitespace-nowrap">{tile.value}</span>}
            caption={
              tile.caption && (
                <span className="text-meta tnum">{tile.caption}</span>
              )
            }
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title={t("monitor.analytics.panels.usage.why")}
          aside={
            recovered > 0 && (
              <Badge variant="muted">
                {t("monitor.analytics.panels.usage.recovered", {
                  n: fmtInt(recovered),
                })}
              </Badge>
            )
          }
        >
          {active.length === 0 ? (
            <Badge variant="success" className="w-fit">
              {t("monitor.analytics.panels.usage.allStored")}
            </Badge>
          ) : (
            <PanelTable
              columns={causeColumns}
              rows={active}
              rowKey={(r) => r.cause}
            />
          )}
        </Panel>
        <Panel title={t("monitor.analytics.panels.usage.limits")}>
          <PanelTable
            columns={limitColumns}
            rows={limitRows}
            rowKey={(r) => r.key}
          />
        </Panel>
      </div>

      {trend.length > 1 && (
        <Panel title={t("monitor.analytics.panels.usage.overTime")}>
          <TrendChart
            points={trend}
            metric="events_accepted"
            label={t("monitor.analytics.panels.usage.stored")}
          />
        </Panel>
      )}

      {sites.length > 1 && <BySite rows={sites} />}
    </>
  );
}

function BySite({ rows }: { rows: Row[] }) {
  const t = useT();
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.usage.site"),
      cell: (r) => <span className="font-mono text-xs">{str(r.k)}</span>,
    },
    {
      id: "requests",
      header: t("monitor.analytics.panels.usage.requests"),
      numeric: true,
      cell: (r) => fmtInt(r.requests),
    },
    {
      id: "bytes",
      header: t("monitor.analytics.panels.usage.bytes"),
      numeric: true,
      cell: (r) => fmtBytes(r.bytes_in),
    },
    {
      id: "stored",
      header: t("monitor.analytics.panels.usage.stored"),
      numeric: true,
      cell: (r) => fmtInt(r.events_accepted),
    },
    ...CAUSES.map((c) => ({
      id: c,
      header: causeText(c, t).label,
      numeric: true,
      cell: (r: Row) => fmtInt(r[c]),
    })),
  ];
  return (
    <Panel title={t("monitor.analytics.panels.usage.bySite")}>
      <PanelTable columns={columns} rows={rows} rowKey={(r) => str(r.k)} />
    </Panel>
  );
}
