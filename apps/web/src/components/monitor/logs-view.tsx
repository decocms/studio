/** The Logs tab: the site's own logs and spans, drawn with the Monitor's cards, chart panel and list. */

import { type ReactNode, useDeferredValue, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  File06,
} from "@untitledui/icons";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { ListRow } from "@decocms/ui/components/list-row.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { IntegrationIcon } from "@/components/integration-icon";
import { Page } from "@/components/page";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useIdSelection } from "@/hooks/use-id-selection.ts";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { LOCALE_TAG } from "@/i18n/locale.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { CopyButton, fetchJson } from "@/layouts/main-panel-tabs/analytics-tab";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { Panel } from "./analytics/panels";
import { Locked, PickProject } from "./locked";
import { ProjectScreen, useSiteProjects } from "./monitor-views";
import { connectLink } from "./parts";
import {
  SITE_EVENT_KINDS,
  SITE_EVENT_LEVELS,
  SITE_EVENT_RANGES,
  type SiteEvent,
  type SiteEventKind,
  type SiteEventLevel,
  type SiteEventRange,
  SiteEventsPage,
} from "./site-events-contract";
import { TopbarSelect } from "./topbar-select";
import { ViewSwitch } from "./view-switch";

/** How often Live reads again. */
const LIVE_MS = 5_000;

/** Each level's color, the same in the rows and the chart. */
const LEVEL: Record<
  SiteEventLevel,
  { dot: string; text: string; fill: string }
> = {
  error: {
    dot: "bg-destructive",
    text: "text-destructive",
    fill: "var(--destructive)",
  },
  warn: { dot: "bg-warning", text: "text-warning", fill: "var(--warning)" },
  info: { dot: "bg-chart-1", text: "text-chart-1", fill: "var(--chart-1)" },
  ok: { dot: "bg-success", text: "text-success", fill: "var(--success)" },
  debug: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    fill: "var(--muted-foreground)",
  },
};

/** Opens, time, level, service, message: one line per event. */
const ROW =
  "grid grid-cols-[1rem_10.5rem_3.5rem_9rem_minmax(0,1fr)] items-center gap-3 px-4";

const ALL = "all";
type Level = SiteEventLevel | typeof ALL;
type Kind = SiteEventKind | typeof ALL;

function rangeLabel(range: SiteEventRange, t: TFunction): string {
  switch (range) {
    case "1h":
      return t("monitor.logs.range.1h");
    case "24h":
      return t("monitor.logs.range.24h");
    case "7d":
      return t("monitor.logs.range.7d");
    default: {
      const unhandled: never = range;
      return unhandled;
    }
  }
}

function levelLabel(level: SiteEventLevel, t: TFunction): string {
  switch (level) {
    case "error":
      return t("monitor.logs.level.error");
    case "warn":
      return t("monitor.logs.level.warn");
    case "info":
      return t("monitor.logs.level.info");
    case "ok":
      return t("monitor.logs.level.ok");
    case "debug":
      return t("monitor.logs.level.debug");
    default: {
      const unhandled: never = level;
      return unhandled;
    }
  }
}

function kindLabel(kind: Kind, t: TFunction): string {
  switch (kind) {
    case "all":
      return t("monitor.logs.kind.all");
    case "log":
      return t("monitor.logs.kind.log");
    case "span":
      return t("monitor.logs.kind.span");
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

interface Filters {
  kind: Kind;
  level: Level;
  service: string;
}

/** The site's events, page by page, with the counts from the first page. */
function useSiteEvents(
  site: string,
  range: SiteEventRange,
  filters: Filters,
  q: string,
  live: boolean,
) {
  const { org } = useProjectContext();
  const params = new URLSearchParams({ range });
  if (filters.kind !== ALL) params.set("kinds", filters.kind);
  if (filters.level !== ALL) params.set("levels", filters.level);
  if (filters.service !== ALL) params.set("services", filters.service);
  if (q) params.set("q", q);
  const base = `/api/${org.slug}/monitor/${encodeURIComponent(site)}/site/events`;
  return useInfiniteQuery({
    queryKey: KEYS.monitorSiteEvents(org.slug, site, params.toString()),
    queryFn: async ({ pageParam }) => {
      const page = new URLSearchParams(params);
      if (pageParam) page.set("cursor", pageParam);
      const body = await fetchJson(`${base}?${page}`);
      // A site that doesn't send its telemetry answers `{ available: false }`.
      if (
        body &&
        typeof body === "object" &&
        "available" in body &&
        body.available === false
      ) {
        return null;
      }
      return SiteEventsPage.parse(body);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    retry: false,
    staleTime: live ? 0 : 30_000,
    refetchInterval: live ? LIVE_MS : false,
    placeholderData: (prev) => prev,
  });
}

/** Made-up counts for the faded Logs behind the connect card. */
const PREVIEW_PAGE: SiteEventsPage = {
  total: 2200,
  histogram: Array.from({ length: 48 }, (_, i) => ({
    t: new Date(Date.UTC(2026, 0, 1, 0, i * 30)).toISOString(),
    ok: 30 + Math.round(12 * Math.sin(i / 4)),
    info: i % 7 === 0 ? 2 : 0,
    warn: i % 5 === 0 ? 3 : 0,
    error: i % 9 === 0 ? 2 : 0,
    debug: 0,
  })),
  facets: {
    levels: { error: 47, warn: 40, info: 13, ok: 2100, debug: 0 },
    services: [],
  },
  events: [],
  nextCursor: null,
};

function LogsPreview() {
  const t = useT();
  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <MetricCard title={t("monitor.logs.events")} value="2,200" />
        <MetricCard title={t("monitor.logs.errors")} value="47" />
        <MetricCard title={t("monitor.logs.warnings")} value="40" />
      </div>
      <MetricCard title={t("monitor.logs.overTime")}>
        <Histogram page={PREVIEW_PAGE} range="24h" />
      </MetricCard>
    </>
  );
}

export function LogsView({
  scopeId,
  onProject,
}: {
  scopeId: string | null;
  onProject: (projectId: string) => void;
}) {
  const views = useControlPlaneViews();
  const projects = useSiteProjects();
  const project = projects.find((p) => p.id === scopeId);
  return (
    <ProjectScreen scopeId={scopeId} enabled={views.monitor}>
      <div className="flex h-full min-h-0 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
          {project ? (
            <Explorer key={project.site} site={project.site} />
          ) : (
            <PickProject projects={projects} onProject={onProject}>
              <LogsPreview />
            </PickProject>
          )}
        </div>
      </div>
    </ProjectScreen>
  );
}

function Explorer({ site }: { site: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<SiteEventRange>("1h");
  const [live, setLive] = useState(false);
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [filters, setFilters] = useState<Filters>({
    kind: ALL,
    level: ALL,
    service: ALL,
  });
  const events = useSiteEvents(site, range, filters, q, live);
  const first = events.data?.pages[0];
  const services = first?.facets.services ?? [];

  const actions = (
    <Page.Actions>
      <label className="text-meta flex cursor-pointer items-center gap-2 px-1">
        <Switch checked={live} onCheckedChange={setLive} />
        {t("orgs.monitoring.live")}
      </label>
      {services.length > 1 && (
        <TopbarSelect
          label={t("monitor.logs.service")}
          value={filters.service}
          options={[
            { value: ALL, label: t("monitor.logs.allServices") },
            ...services.map((s) => ({ value: s.name, label: s.name })),
          ]}
          onChange={(service) => setFilters({ ...filters, service })}
        />
      )}
      <TopbarSelect
        label={t("monitor.logs.type")}
        value={filters.kind}
        options={([ALL, ...SITE_EVENT_KINDS] as const).map((k) => ({
          value: k,
          label: kindLabel(k, t),
        }))}
        onChange={(kind) => setFilters({ ...filters, kind })}
      />
      <TopbarSelect
        label={t("monitor.logs.rangeLabel")}
        period
        value={range}
        options={SITE_EVENT_RANGES.map((r) => ({
          value: r,
          label: rangeLabel(r, t),
        }))}
        onChange={setRange}
      />
    </Page.Actions>
  );

  if (events.isLoading) {
    return (
      <>
        {actions}
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-96" />
      </>
    );
  }
  if (events.error) {
    return (
      <>
        {actions}
        <EmptyState
          icon={<File06 size={20} />}
          tone="error"
          title={t("monitor.logs.loadError")}
          description={events.error.message}
        />
      </>
    );
  }
  if (!first) {
    return (
      <Locked
        kind="analytics"
        title={t("monitor.logs.unavailable")}
        link={connectLink(org.slug, null)}
        guide={
          <div>
            <ListRow
              variant="divided"
              lead={
                <IntegrationIcon
                  icon="/logos/deco%20logo.svg"
                  name={t("monitor.logs.blocks")}
                  size="xs"
                  fit="contain"
                />
              }
              title={t("monitor.logs.blocks")}
              meta={t("monitor.logs.blocksMeta")}
            />
          </div>
        }
      >
        <LogsPreview />
      </Locked>
    );
  }

  const nf = new Intl.NumberFormat();
  const levels = first.facets.levels;
  const all = SITE_EVENT_LEVELS.reduce((sum, l) => sum + levels[l], 0);
  const share = (n: number) =>
    all > 0
      ? t("monitor.logs.share", {
          share: new Intl.NumberFormat(undefined, {
            style: "percent",
            maximumFractionDigits: 1,
          }).format(n / all),
        })
      : null;
  const rows = events.data?.pages.flatMap((p) => p?.events ?? []) ?? [];
  const filtered = q.length > 0 || filters.level !== ALL;

  return (
    <>
      {actions}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard title={t("monitor.logs.events")} value={nf.format(all)} />
        <MetricCard
          title={t("monitor.logs.errors")}
          value={nf.format(levels.error)}
          caption={
            levels.error > 0 && (
              <span className="text-meta">{share(levels.error)}</span>
            )
          }
        />
        <MetricCard
          title={t("monitor.logs.warnings")}
          value={nf.format(levels.warn)}
          caption={
            levels.warn > 0 && (
              <span className="text-meta">{share(levels.warn)}</span>
            )
          }
        />
      </div>
      <Panel title={t("monitor.logs.overTime")}>
        <Histogram page={first} range={range} />
      </Panel>
      <section className="surface flex flex-col gap-3 px-4 pt-4 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ViewSwitch label={t("monitor.logs.levelLabel")}>
            {([ALL, ...SITE_EVENT_LEVELS] as const).map((level) => (
              <ViewSwitch.Item
                key={level}
                pressed={filters.level === level}
                onClick={() => setFilters({ ...filters, level })}
              >
                {level === ALL
                  ? t("monitor.logs.level.all")
                  : levelLabel(level, t)}
              </ViewSwitch.Item>
            ))}
          </ViewSwitch>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("monitor.logs.search")}
            className="w-full sm:w-56"
          />
        </div>
        <EventList
          rows={rows}
          empty={filtered ? t("monitor.logs.noMatch") : t("monitor.logs.empty")}
          more={{
            has: events.hasNextPage,
            fetching: events.isFetchingNextPage,
            next: () => void events.fetchNextPage(),
          }}
        />
      </section>
    </>
  );
}

function Histogram({
  page,
  range,
}: {
  page: SiteEventsPage;
  range: SiteEventRange;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const tag = LOCALE_TAG[preferences.language];
  const compact = new Intl.NumberFormat(tag, { notation: "compact" });
  const tick = new Intl.DateTimeFormat(
    tag,
    range === "7d"
      ? { month: "short", day: "numeric" }
      : { hour: "2-digit", minute: "2-digit" },
  );
  const config = Object.fromEntries(
    SITE_EVENT_LEVELS.map((level) => [
      level,
      { label: levelLabel(level, t), color: LEVEL[level].fill },
    ]),
  );
  return (
    <ChartContainer config={config} className="h-48 w-full">
      <BarChart
        data={page.histogram}
        margin={{ top: 4, right: -8, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          strokeDasharray="4 4"
          stroke="var(--border)"
          strokeOpacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="t"
          axisLine={false}
          tickLine={false}
          tick={AXIS_TICK}
          tickMargin={6}
          minTickGap={48}
          tickFormatter={(v: string) => tick.format(new Date(v))}
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
          content={
            <ChartTooltipContent
              labelFormatter={(v) =>
                typeof v === "string" ? tick.format(new Date(v)) : v
              }
            />
          }
        />
        {[...SITE_EVENT_LEVELS].reverse().map((level, i) => (
          <Bar
            key={level}
            dataKey={level}
            stackId="levels"
            fill={`var(--color-${level})`}
            radius={i === SITE_EVENT_LEVELS.length - 1 ? [3, 3, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

function Dot({ level }: { level: SiteEventLevel }) {
  const t = useT();
  return (
    <span
      role="img"
      aria-label={levelLabel(level, t)}
      className={cn("size-2 shrink-0 rounded-full", LEVEL[level].dot)}
    />
  );
}

function EventList({
  rows,
  empty,
  more,
}: {
  rows: SiteEvent[];
  empty: string;
  more: { has: boolean; fetching: boolean; next: () => void };
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const tag = LOCALE_TAG[preferences.language];
  const selection = useIdSelection(rows);
  const selected = selection.selected;
  const lastRef = useInfiniteScroll(
    () => {
      if (more.has && !more.fetching) more.next();
    },
    more.has,
    more.fetching,
  );
  const stamp = new Intl.DateTimeFormat(tag, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // Events a few milliseconds apart need the milliseconds to read in order.
  const precise = new Intl.DateTimeFormat(tag, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });

  if (rows.length === 0) return <EmptyState size="inline" title={empty} />;

  return (
    <>
      <div className="-mx-4 overflow-x-auto">
        <div className="flex min-w-[640px] flex-col">
          <div className={cn(ROW, "text-meta border-b border-border/70 pb-2")}>
            <span />
            <span>{t("monitor.logs.col.time")}</span>
            <span>{t("monitor.logs.levelLabel")}</span>
            <span>{t("monitor.logs.service")}</span>
            <span>{t("monitor.logs.col.message")}</span>
          </div>
          {rows.map((event, i) => (
            <button
              key={event.id}
              ref={i === rows.length - 1 ? lastRef : undefined}
              type="button"
              onClick={() => selection.select(event.id)}
              className={cn(
                ROW,
                "focus-ring group w-full cursor-pointer border-b border-border/50 py-1.5 text-left transition-colors hover:bg-accent/40",
                selected?.id === event.id && "bg-accent",
              )}
            >
              <ChevronRight
                size={14}
                className="text-muted-foreground transition-transform group-hover:translate-x-0.5"
              />
              <span className="tnum truncate text-sm text-muted-foreground">
                {precise.format(new Date(event.timestamp))}
              </span>
              <span
                className={cn("text-sm lowercase", LEVEL[event.level].text)}
              >
                {event.level}
              </span>
              <span className="truncate text-sm text-muted-foreground">
                {event.service}
              </span>
              <span className="truncate font-mono text-xs text-foreground">
                {event.message}
              </span>
            </button>
          ))}
        </div>
      </div>
      {more.fetching && (
        <div className="flex justify-center py-3">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      )}

      <Sheet
        open={selection.isOpen}
        onOpenChange={(open) => {
          if (!open) selection.close();
        }}
      >
        <SheetContent className="flex flex-col gap-0 p-0 sm:max-w-2xl">
          {selected && (
            <EventDetail
              event={selected}
              stamp={stamp}
              nav={{
                prev: selection.prev,
                next: selection.next,
                first: selection.index === 0,
                last: selection.index === rows.length - 1,
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-meta">{label}</span>
      <span className="truncate text-sm text-foreground">{children}</span>
    </div>
  );
}

function EventDetail({
  event,
  stamp,
  nav,
}: {
  event: SiteEvent;
  stamp: Intl.DateTimeFormat;
  nav: { prev: () => void; next: () => void; first: boolean; last: boolean };
}) {
  const t = useT();
  const attributes = Object.entries(event.attributes);
  return (
    <>
      <SheetHeader className="shrink-0 border-b border-border px-6 pt-6 pb-5">
        <div className="flex items-start justify-between gap-3 pr-8">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-meta flex items-center gap-1.5">
              <Dot level={event.level} />
              {levelLabel(event.level, t)}
            </span>
            <SheetTitle className="line-clamp-2 text-sm leading-snug">
              {event.message}
            </SheetTitle>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label={t("orgs.audit.previousEntry")}
              onClick={nav.prev}
              disabled={nav.first}
            >
              <ChevronUp />
            </IconButton>
            <IconButton
              label={t("orgs.audit.nextEntry")}
              onClick={nav.next}
              disabled={nav.last}
            >
              <ChevronDown />
            </IconButton>
          </div>
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Fact label={t("monitor.logs.col.time")}>
            <span className="tnum">
              {stamp.format(new Date(event.timestamp))}
            </span>
          </Fact>
          <Fact label={t("monitor.logs.service")}>{event.service}</Fact>
          <Fact label={t("monitor.logs.type")}>{kindLabel(event.kind, t)}</Fact>
          {event.durationMs !== null && (
            <Fact label={t("monitor.logs.detail.duration")}>
              <span className="tnum">{Math.round(event.durationMs)}ms</span>
            </Fact>
          )}
          {event.traceId && (
            <Fact label={t("monitor.logs.detail.trace")}>
              <span className="font-mono text-xs">{event.traceId}</span>
            </Fact>
          )}
          {event.spanId && (
            <Fact label={t("monitor.logs.detail.span")}>
              <span className="font-mono text-xs">{event.spanId}</span>
            </Fact>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-meta">{t("monitor.logs.col.message")}</span>
            <CopyButton text={event.message} />
          </div>
          <pre className="surface-inset whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs text-foreground">
            {event.message}
          </pre>
        </div>

        {attributes.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-meta">
              {t("monitor.logs.detail.attributes")}
            </span>
            <dl className="surface-inset divide-y divide-border/60">
              {attributes.map(([key, value]) => (
                <div
                  key={key}
                  className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-3 px-3 py-2"
                >
                  <dt className="truncate font-mono text-xs text-muted-foreground">
                    {key}
                  </dt>
                  <dd className="break-all font-mono text-xs text-foreground">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </>
  );
}
