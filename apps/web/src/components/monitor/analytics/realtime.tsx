import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { z } from "zod";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { LOCALE_TAG } from "@/i18n/locale.ts";
import { useT } from "@/i18n/use-t.ts";
import { isNotConfigured } from "@/layouts/main-panel-tabs/analytics-tab";
import { AXIS_TICK } from "@/layouts/task-board/analytics-sections";
import { LiveGlobe } from "@/layouts/main-panel-tabs/analytics-globe-tab";
import { Panel, RankedList } from "./panels";
import { useDecoView } from "./segment";
import type { SectionProps } from "./types";

const count = z.coerce.number().catch(0);
const text = z.string().catch("");

/** The `live` view's panels this section draws, as queries.mjs selects them. */
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
          <section
            key={label}
            className="surface @container flex min-w-0 flex-col gap-1 px-4 pt-4 pb-5"
          >
            <h3 className="flex items-center gap-2 text-sm text-foreground/70">
              {live && <LivePulse label={t("monitor.analytics.live.live")} />}
              {label}
            </h3>
            <span className="tnum whitespace-nowrap text-4xl font-normal text-foreground @max-xs:text-3xl">
              {value}
            </span>
          </section>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <LiveGlobe
            base={`/api/${orgSlug}/hosting/${encodeURIComponent(site)}`}
            orgSlug={orgSlug}
            site={site}
            rows={data.liveGeo}
            title={t("monitor.analytics.live.title")}
          />
        </div>
        <div className="flex flex-col gap-4">
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
          <div className="flex-1">
            <RankedList
              title={t("monitor.analytics.live.pagesTitle")}
              aside={
                <span className="text-meta">
                  {t("monitor.analytics.live.pagesVisitors")}
                </span>
              }
              rows={data.livePages}
              format={(n) => nf.format(n)}
              share={false}
            />
          </div>
        </div>
      </div>
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
