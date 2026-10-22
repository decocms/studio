/**
 * The board from what is wired today: the order monitor (stores, their day,
 * their rules' verdicts), the projects with a site or a repository, and the
 * org's connections for the sources not wired into the page yet. Sections
 * nothing feeds stay null, so the page leaves them out instead of faking.
 */

import type { OrderMonitorChannel } from "@decocms/shared/order-monitor";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import {
  useOrderMonitorDays,
  useOrderMonitorStores,
} from "@/hooks/use-order-monitor";
import { usePublicConfig } from "@/hooks/use-public-config";
import { useConnections, useVirtualMCPsNonBlocking } from "@/sdk";
import {
  type Comparison,
  type Kpi,
  type MetricPoint,
  type MonitorBoard,
  type ProjectRow,
  type Signal,
  type SourceRow,
  storeStatus,
  sum,
  worstStatus,
} from "./board";

const matches = (
  connection: { app_name: string | null; app_id: string | null },
  needle: string,
) =>
  (connection.app_name ?? "").includes(needle) ||
  (connection.app_id ?? "").includes(needle);

export function useLiveBoard(
  orgSlug: string,
  scopeId: string | null,
  /** A past local day, `YYYY-MM-DD`; today when absent. */
  date?: string,
): { board: MonitorBoard; loading: boolean; error: Error | null } {
  const config = usePublicConfig();
  const storesQuery = useOrderMonitorStores(
    orgSlug,
    config.orderMonitorEnabled === true,
  );
  const allStores = storesQuery.data ?? [];
  const stores = scopeId
    ? allStores.filter((s) => s.agentIds.includes(scopeId))
    : allStores;
  const dayQueries = useOrderMonitorDays(
    orgSlug,
    stores.map((s) => s.connectionId),
    date ? new Date(`${date}T23:59:59`).toISOString() : undefined,
  );
  const dayOf = new Map(
    stores.flatMap((store, i) => {
      const day = dayQueries[i]?.data;
      return day ? [[store.connectionId, day] as const] : [];
    }),
  );
  const days = [...dayOf.values()];
  const projects = useVirtualMCPsNonBlocking();
  const connections = useConnections();

  const daysReady = days.length === stores.length && stores.length > 0;

  const signals: Signal[] = stores.flatMap((store) =>
    store.rules.flatMap((r): Signal[] =>
      r.status === "warning" || r.status === "alert"
        ? [
            {
              kind: "orders",
              id: `${store.connectionId}:${r.rule}`,
              severity: r.status,
              since: r.since,
              projectId: store.agentIds[0] ?? null,
              storeId: store.connectionId,
              storeTitle: store.title,
              rule: r.rule,
              observed: r.verdict.observed,
              expected: r.verdict.expected,
              after: null,
              task: r.task,
            },
          ]
        : [],
    ),
  );

  const scoped = scopeId ? projects.filter((p) => p.id === scopeId) : projects;
  const sites = scoped.filter((p) => resolveAgentSiteSlug(p));
  const repos = scoped.filter((p) => p.metadata?.repository);
  const analytics = connections.filter((c) => matches(c, "google-analytics"));
  const search = connections.filter((c) => matches(c, "search-console"));
  const vtex = connections.filter(
    (c) => matches(c, "vtex") || matches(c, "shopify"),
  );
  const lastEvaluated = stores
    .flatMap((s) => s.rules.map((r) => r.evaluatedAt))
    .sort()
    .at(-1);

  const sources: SourceRow[] = [
    stores.length > 0
      ? {
          id: "orders",
          state: "live",
          detail: { provider: "VTEX", count: stores.length },
          lastEventAt: lastEvaluated ?? null,
          lakeRows: null,
          icon: vtex[0]?.icon ?? null,
        }
      : {
          // A store connected without the order ingest isn't in the lake yet.
          id: "orders",
          state: vtex.length > 0 ? "partial" : "off",
          detail:
            vtex.length > 0 ? { provider: "VTEX", count: vtex.length } : null,
          lastEventAt: null,
          lakeRows: null,
          icon: vtex[0]?.icon ?? null,
        },
    {
      id: "site",
      state: sites.length > 0 ? "live" : "off",
      detail:
        sites.length > 0 ? { provider: "deco", count: sites.length } : null,
      lastEventAt: null,
      lakeRows: null,
    },
    {
      id: "deploys",
      state: repos.length > 0 ? "live" : "off",
      detail:
        repos.length > 0 ? { provider: "GitHub", count: repos.length } : null,
      lastEventAt: null,
      lakeRows: null,
    },
    {
      id: "analytics",
      icon: analytics[0]?.icon ?? null,
      state: analytics.length > 0 ? "live" : "off",
      detail:
        analytics.length > 0
          ? { provider: "Google", count: analytics.length }
          : null,
      lastEventAt: null,
      lakeRows: null,
    },
    {
      id: "search",
      icon: search[0]?.icon ?? null,
      state: search.length > 0 ? "live" : "off",
      detail:
        search.length > 0 ? { provider: "Google", count: search.length } : null,
      lastEventAt: null,
      lakeRows: null,
    },
  ];

  // Orders and cancellations are the metrics wired today, in the order
  // monitor's hours: each hour sits at its middle 5-minute bucket.
  const kpis: Kpi[] = [];
  if (stores.length > 0) {
    const hourly = (key: "today" | Comparison, h: number) =>
      days.length === 0 ? null : sum(days.map((d) => d.orders[key][h] ?? null));
    // The hour under way belongs to the projection, so the line of what has
    // happened ends at the last full hour and the dashed one carries on.
    const running =
      days.length === 0
        ? 0
        : Math.min(...days.map((d) => Math.floor(d.done / 4)));
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const points: MetricPoint[] = hours
      .filter((h) => h < running)
      .map((h) => ({
        bucket: h * 12 + 6,
        value: hourly("today", h),
        d1: hourly("d1", h),
        w1: hourly("w1", h),
        y1: hourly("y1", h),
      }));
    // The hours still to come: the order monitor's expected count, which past
    // now is its projection, beside the reference days' same hours.
    const projection: MetricPoint[] = hours
      .filter((h) => h >= running)
      .map((h) => ({
        bucket: h * 12 + 6,
        value:
          days.length === 0
            ? null
            : sum(days.map((d) => d.orders.expected[h] ?? null)),
        d1: hourly("d1", h),
        w1: hourly("w1", h),
        y1: hourly("y1", h),
      }));
    kpis.push({
      id: "orders",
      source: "orders",
      value: daysReady ? sum(days.map((d) => d.headline.projected)) : null,
      soFar: daysReady ? sum(days.map((d) => sum(d.orders.today))) : undefined,
      references: {
        d1: daysReady ? sum(days.map((d) => d.headline.d1)) : null,
        w1: daysReady ? sum(days.map((d) => d.headline.w1)) : null,
        y1: daysReady ? sum(days.map((d) => d.headline.y1)) : null,
      },
      points: daysReady ? points : null,
      projection: daysReady ? projection : undefined,
    });
    // Cancellations per hour so far, the hour under way included; each
    // reference day counted up to the same hour, so the figures compare.
    const canceled = (key: "today" | Comparison, h: number) =>
      days.length === 0
        ? null
        : sum(days.map((d) => d.cancellations.canceled[key][h] ?? null));
    const upToNow = hours.filter((h) => h <= running);
    const soFarOf = (key: Comparison) =>
      daysReady ? sum(upToNow.map((h) => canceled(key, h))) : null;
    kpis.push({
      id: "cancellations",
      source: "orders",
      value: daysReady ? sum(upToNow.map((h) => canceled("today", h))) : null,
      references: { d1: soFarOf("d1"), w1: soFarOf("w1"), y1: soFarOf("y1") },
      points: daysReady
        ? upToNow.map((h) => ({
            bucket: h * 12 + 6,
            value: canceled("today", h),
            d1: canceled("d1", h),
            w1: canceled("w1", h),
            y1: canceled("y1", h),
          }))
        : null,
    });
  }
  if (analytics.length === 0) {
    kpis.push({
      id: "conversion",
      source: "analytics",
      value: null,
      references: { d1: null, w1: null, y1: null },
      points: null,
    });
  }

  // Channels, summed by name across the stores in scope.
  const byChannel = new Map<string, OrderMonitorChannel>();
  for (const d of days) {
    for (const c of d.channels) {
      const key = c.name ?? c.id;
      const prev = byChannel.get(key);
      byChannel.set(
        key,
        prev
          ? {
              ...prev,
              today: prev.today.map((v, h) =>
                v === null && c.today[h] === null
                  ? null
                  : (v ?? 0) + (c.today[h] ?? 0),
              ),
              d1: prev.d1.map((v, h) => v + (c.d1[h] ?? 0)),
              soFar: prev.soFar + c.soFar,
              d1SoFar: prev.d1SoFar + c.d1SoFar,
            }
          : { ...c, id: key },
      );
    }
  }

  const projectRows: ProjectRow[] = scoped.flatMap((project) => {
    const own = stores.filter((s) => s.agentIds.includes(project.id));
    if (own.length === 0) return [];
    const ownDays = own.flatMap((s) => {
      const day = dayOf.get(s.connectionId);
      return day ? [day] : [];
    });
    return [
      {
        id: project.id,
        title: project.title,
        status: worstStatus(own.map(storeStatus)),
        orders: ownDays.length
          ? sum(ownDays.map((d) => d.headline.projected))
          : null,
        ordersPrevious: ownDays.length
          ? sum(ownDays.map((d) => d.headline.d1))
          : null,
        ordersSeries: null,
        conversion: null,
        errorRate: null,
        lastDeploy: null,
        signals: signals.filter((s) => s.projectId === project.id).length,
      },
    ];
  });

  return {
    board: {
      checkedAt: lastEvaluated ?? null,
      dayStart: days[0]
        ? new Date(`${days[0].date}T00:00:00`).toISOString()
        : new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
      kpis,
      channels: daysReady ? [...byChannel.values()] : null,
      stores: stores.map((store) => ({ store })),
      deploys: null,
      deployHistory: null,
      signals,
      projects: projectRows,
      experiments: null,
      sources,
    },
    loading: storesQuery.isLoading,
    error: storesQuery.error,
  };
}
