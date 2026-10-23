/**
 * The board from what is wired today: the order monitor (stores, their day,
 * their rules' verdicts), the projects with a site or a repository, and the
 * org's connections for the sources not wired into the page yet. Sections
 * nothing feeds stay null, so the page leaves them out instead of faking.
 */

import type { OrderMonitorChannel } from "@decocms/shared/order-monitor";
import { sameRepositoryBinding } from "@decocms/shared/repository-binding";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { localInstant } from "@/components/order-monitor/order-monitor-day";
import { useFeature } from "@/hooks/use-entitlements";
import {
  useRepositories,
  useRepositoryDeploys,
} from "@/hooks/use-git-providers";
import {
  useOrderMonitorDays,
  useOrderMonitorStores,
} from "@/hooks/use-order-monitor";
import { usePublicConfig } from "@/hooks/use-public-config";
import { useConnections, useVirtualMCPsNonBlocking } from "@/sdk";
import {
  type Comparison,
  type Deploy,
  type Kpi,
  type MetricPoint,
  type MonitorBoard,
  type ProjectRow,
  measureDeploy,
  type Signal,
  type SourceRow,
  type StoreHours,
  storeStatus,
  storeTimezone,
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
  // Off the plan, the order monitor answers 403: no stores, not a broken page.
  const monitoring = useFeature("monitoring");
  const storesQuery = useOrderMonitorStores(
    orgSlug,
    config.orderMonitorEnabled === true && monitoring,
  );
  const allStores = monitoring ? (storesQuery.data ?? []) : [];
  const stores = scopeId
    ? allStores.filter((s) => s.agentIds.includes(scopeId))
    : allStores;
  // A past day ends at midnight in each store's own timezone.
  const dayQueries = useOrderMonitorDays(
    orgSlug,
    stores.map((s) => ({
      connectionId: s.connectionId,
      at: date ? localInstant(date, "23:59:59", storeTimezone(s)) : undefined,
    })),
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
  const repositories = useRepositories().data ?? [];
  const monitored = repositories.filter((r) => r.monitorDeploys);
  const pushes = useRepositoryDeploys(monitored.map((r) => r.id)).data ?? [];

  const daysReady = days.length === stores.length && stores.length > 0;
  // A store whose day failed would leave every total waiting on it.
  const dayError = dayQueries.find((q) => q.error)?.error ?? null;

  // The rules' states are now's; a past day has no verdicts of its own.
  const signals: Signal[] = (date ? [] : stores).flatMap((store) =>
    store.rules.flatMap((r): Signal[] =>
      r.status === "warning" || r.status === "alert"
        ? [
            {
              kind: "orders",
              id: `${store.connectionId}:${r.rule}`,
              severity: r.status,
              since: r.since,
              projectId: scopeId ?? store.agentIds[0] ?? null,
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
      // Imported repositories, every one of them switched off, are half way there.
      id: "deploys",
      state:
        monitored.length > 0
          ? "live"
          : repositories.length > 0
            ? "partial"
            : "off",
      detail:
        monitored.length > 0
          ? { provider: "GitHub", count: monitored.length }
          : null,
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

  // The hour under way belongs to the projection, so the line of what has
  // happened ends at the last full hour and the dashed one carries on.
  const running =
    days.length === 0
      ? 0
      : Math.min(...days.map((d) => Math.floor(d.done / 4)));

  // Orders and cancellations are the metrics wired today, in the order
  // monitor's hours: each hour sits at its middle 5-minute bucket.
  const kpis: Kpi[] = [];
  if (stores.length > 0) {
    const hourly = (key: "today" | Comparison, h: number) =>
      days.length === 0 ? null : sum(days.map((d) => d.orders[key][h] ?? null));
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
        // By store: a store several projects aggregate alerts in each of them.
        signals: signals.filter(
          (s) =>
            s.kind === "orders" &&
            own.some((store) => store.connectionId === s.storeId),
        ).length,
      },
    ];
  });

  const storeHours = (connectionId: string): StoreHours[] => {
    const day = dayOf.get(connectionId);
    return day
      ? [
          {
            start: Date.parse(localInstant(day.date, "00:00:00", day.timezone)),
            done: day.done,
            today: day.orders.today,
            w1: day.orders.w1,
          },
        ]
      : [];
  };
  const repositoryOf = new Map(monitored.map((r) => [r.id, r]));
  // Each push is measured on the orders of the stores its projects sell through.
  const deployHistory: Deploy[] | null =
    monitored.length === 0
      ? null
      : pushes.flatMap((push): Deploy[] => {
          const repository = repositoryOf.get(push.repositoryId);
          const last = push.commits.at(-1);
          if (!repository || !last) return [];
          const target = {
            repositoryId: repository.id,
            url: repository.webUrl,
          };
          const bound = scoped.filter((p) => {
            const binding = p.metadata?.repository;
            return !!binding && sameRepositoryBinding(binding, target);
          });
          if (scopeId && bound.length === 0) return [];
          const own = stores.filter((s) =>
            bound.some((p) => s.agentIds.includes(p.id)),
          );
          return [
            {
              id: `${push.repositoryId}:${last.sha}`,
              kind: "deploy",
              projectId: scopeId ?? bound[0]?.id ?? null,
              projectTitle: bound[0]?.title ?? repository.path,
              at: push.at,
              message: last.message,
              author: last.author,
              task: null,
              around: null,
              ...measureDeploy(
                Date.parse(push.at),
                own.flatMap((s) => storeHours(s.connectionId)),
              ),
            },
          ];
        });
  const dayStart = days[0]
    ? localInstant(days[0].date, "00:00:00", days[0].timezone)
    : new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const dayStartMs = Date.parse(dayStart);

  return {
    board: {
      checkedAt: lastEvaluated ?? null,
      dayStart,
      kpis,
      // Only full hours, like the orders line.
      channels: daysReady
        ? [...byChannel.values()].map((c) => ({
            ...c,
            today: c.today.map((v, h) => (h < running ? v : null)),
          }))
        : null,
      stores: stores.map((store) => ({ store })),
      deploys:
        deployHistory?.filter((d) => {
          const at = Date.parse(d.at);
          return at >= dayStartMs && at < dayStartMs + 86_400_000;
        }) ?? null,
      deployHistory,
      signals,
      projects: projectRows,
      experiments: null,
      sources,
    },
    // A store's day still on its way is loading, not a source with no data.
    loading: storesQuery.isLoading || dayQueries.some((q) => q.isLoading),
    error: (monitoring ? storesQuery.error : null) ?? dayError,
  };
}
