import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { z } from "zod";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import type { Locale } from "@/i18n/locale.ts";
import { useT } from "@/i18n/use-t.ts";
import { isNotConfigured } from "@/layouts/main-panel-tabs/analytics-tab";
import { AXIS_TICK } from "@/layouts/task-board/analytics-sections";
import { LiveMap, useGlobeBundle } from "./live-map";
import { useDecoView } from "./segment";
import type { SectionProps } from "./types";

const count = z.coerce.number().catch(0);
const text = z.string().catch("");

/** The `live` view's panels, column for column as queries.mjs selects them. */
const LivePayload = z.object({
  liveVisitors: z
    .array(
      z.object({
        visitors: count,
        pageviews: count,
        events: count,
        last_event: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
  livePages: z.array(z.object({ k: text, n: count })).catch([]),
  liveFeed: z
    .array(
      z.object({
        ts: text,
        name: text,
        path: text,
        device: text,
        country: text,
        region: text,
        city: text,
        source: text,
      }),
    )
    .catch([]),
  liveByMinute: z
    .array(z.object({ t: text, visitors: count, events: count }))
    .catch([]),
  liveGeo: z
    .array(
      z.object({
        kind: text,
        country: text,
        region: text,
        city: text,
        lat: z.number().nullable().catch(null),
        lng: z.number().nullable().catch(null),
        visitors: count,
      }),
    )
    .catch([]),
});

const LOCALE_TAG: Record<Locale, string> = { en: "en-US", "pt-BR": "pt-BR" };

/** The read surface's timestamps are UTC `YYYY-MM-DD HH:MM:SS` with no zone. */
function parseUtc(value: string | null): Date | null {
  if (!value || value.startsWith("1970-01-01")) return null;
  const iso = value.replace(" ", "T");
  const at = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function RealtimeSection({ orgSlug, site, segment }: SectionProps) {
  const t = useT();
  const [preferences] = usePreferences();
  const tag = LOCALE_TAG[preferences.language];
  const query = useDecoView({
    orgSlug,
    site,
    view: "live",
    range: "5m",
    segment,
  });
  const globe = useGlobeBundle(orgSlug, site);

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[28rem] rounded-xl" />
      </div>
    );
  }
  if (query.error) {
    return (
      <p className="text-sm text-muted-foreground">
        {isNotConfigured(query.error)
          ? t("monitor.analytics.live.notConfigured")
          : t("monitor.analytics.live.loadError")}
      </p>
    );
  }

  const data = LivePayload.parse(query.data?.data ?? {});
  const nf = new Intl.NumberFormat(tag);
  const compact = new Intl.NumberFormat(tag, { notation: "compact" });
  const clock = new Intl.DateTimeFormat(tag, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const headline = data.liveVisitors[0];
  const lastEvent = parseUtc(headline?.last_event ?? null);
  const kpis: ReadonlyArray<[string, string, boolean]> = [
    [
      t("monitor.analytics.live.visitorsNow"),
      nf.format(headline?.visitors ?? 0),
      true,
    ],
    [
      t("monitor.analytics.live.pageviews"),
      nf.format(headline?.pageviews ?? 0),
      false,
    ],
    [
      t("monitor.analytics.live.events"),
      nf.format(headline?.events ?? 0),
      false,
    ],
    [
      t("monitor.analytics.live.lastEvent"),
      lastEvent ? clock.format(lastEvent) : "—",
      false,
    ],
  ];

  const trend = data.liveByMinute.map((r) => {
    const at = parseUtc(r.t);
    return { label: at ? clock.format(at) : r.t, visitors: r.visitors };
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(([label, value, live]) => (
          <section key={label} className="surface flex flex-col gap-2 p-4">
            <h3 className="flex items-center gap-2 text-sm text-foreground/70">
              {live && <LivePulse label={t("monitor.analytics.live.live")} />}
              {label}
            </h3>
            <span className="tnum font-display text-3xl text-foreground">
              {value}
            </span>
          </section>
        ))}
      </div>

      <div
        className={cn(
          "grid gap-4",
          globe.state === "failed"
            ? "items-start lg:grid-cols-2"
            : "xl:grid-cols-3",
        )}
      >
        {globe.state !== "failed" && (
          <div className="h-[34rem] xl:col-span-2">
            <LiveMap
              load={globe}
              rows={data.liveGeo}
              stamp={query.dataUpdatedAt}
            />
          </div>
        )}
        <div
          className={cn(
            globe.state === "failed" ? "contents" : "flex flex-col gap-4",
          )}
        >
          <Panel title={t("monitor.analytics.live.trendTitle")}>
            <ChartContainer
              config={{
                visitors: {
                  label: t("monitor.analytics.live.trendVisitors"),
                  color: "var(--chart-2)",
                },
              }}
              className="h-40 w-full"
            >
              <BarChart
                data={trend}
                margin={{ top: 4, right: -8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="4 4"
                  stroke="var(--border)"
                  strokeOpacity={0.5}
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS_TICK}
                  tickMargin={6}
                  minTickGap={32}
                  interval="preserveStartEnd"
                  tickFormatter={(v: string) => v.slice(0, 5)}
                />
                <YAxis
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS_TICK}
                  tickFormatter={(v: number) => compact.format(v)}
                  width={52}
                  tickCount={4}
                />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)" }}
                  content={<ChartTooltipContent />}
                />
                <Bar
                  dataKey="visitors"
                  fill="var(--color-visitors)"
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
          </Panel>
          <Panel title={t("monitor.analytics.live.pagesTitle")} grow>
            {data.livePages.length > 0 ? (
              <RankedPages
                rows={data.livePages}
                format={(n) => nf.format(n)}
                pageLabel={t("monitor.analytics.live.pagesPage")}
                valueLabel={t("monitor.analytics.live.pagesVisitors")}
              />
            ) : (
              <Empty text={t("monitor.analytics.live.empty")} />
            )}
          </Panel>
        </div>
      </div>

      <Panel title={t("monitor.analytics.live.feedTitle")} flush>
        {data.liveFeed.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  {[
                    t("monitor.analytics.live.feedWhen"),
                    t("monitor.analytics.live.feedEvent"),
                    t("monitor.analytics.live.feedPage"),
                    t("monitor.analytics.live.feedWhere"),
                    t("monitor.analytics.live.feedDevice"),
                    t("monitor.analytics.live.feedSource"),
                  ].map((h, i) => (
                    <TableHead
                      key={h}
                      className={cn(
                        "h-8 whitespace-nowrap text-xs font-normal text-muted-foreground",
                        i === 0 && "pl-4",
                      )}
                    >
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.liveFeed.map((r, i) => {
                  const at = parseUtc(r.ts);
                  const where = [r.city, r.region, r.country]
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <TableRow key={`${r.ts}-${i}`} className="border-border/50">
                      <TableCell className="tnum py-1.5 pl-4 text-xs text-muted-foreground">
                        {at ? clock.format(at) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "py-1.5 font-mono text-xs",
                          r.name.startsWith("$")
                            ? "text-muted-foreground"
                            : "text-foreground",
                        )}
                      >
                        {r.name || "—"}
                      </TableCell>
                      <TableCell className="max-w-72 truncate py-1.5 font-mono text-xs text-foreground">
                        {r.path || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-1.5 text-sm text-foreground">
                        {where || "—"}
                      </TableCell>
                      <TableCell className="py-1.5 text-sm text-muted-foreground">
                        {r.device || "—"}
                      </TableCell>
                      <TableCell className="py-1.5 text-sm text-muted-foreground">
                        {r.source || "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="px-4 pb-4">
            <Empty text={t("monitor.analytics.live.empty")} />
          </div>
        )}
      </Panel>
    </div>
  );
}

function LivePulse({ label }: { label: string }) {
  return (
    <span className="relative flex size-2" role="img" aria-label={label}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-75 motion-reduce:animate-none" />
      <span className="relative inline-flex size-2 rounded-full bg-brand" />
    </span>
  );
}

function Panel({
  title,
  grow,
  flush,
  children,
}: {
  title: string;
  grow?: boolean;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn("surface flex flex-col overflow-hidden", grow && "flex-1")}
    >
      <h3 className="px-4 pt-3 pb-2 text-sm font-medium text-foreground">
        {title}
      </h3>
      <div className={cn(!flush && "px-4 pb-4")}>{children}</div>
    </section>
  );
}

function Empty({ text: message }: { text: string }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground">{message}</p>
  );
}

function RankedPages({
  rows,
  format,
  pageLabel,
  valueLabel,
}: {
  rows: ReadonlyArray<{ k: string; n: number }>;
  format: (n: number) => string;
  pageLabel: string;
  valueLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between px-2.5 pb-1 text-meta">
        <span>{pageLabel}</span>
        <span>{valueLabel}</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.k}
          className="relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-2.5 py-1.5"
        >
          <div
            className="surface-inset absolute inset-y-0 left-0 rounded-md"
            style={{ width: `${(r.n / max) * 100}%` }}
          />
          <span className="relative truncate font-mono text-xs text-foreground">
            {r.k || "—"}
          </span>
          <span className="tnum relative shrink-0 text-sm text-foreground">
            {format(r.n)}
          </span>
        </div>
      ))}
    </div>
  );
}
