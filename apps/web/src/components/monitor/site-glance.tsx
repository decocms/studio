import { useQuery } from "@tanstack/react-query";
import { useT } from "@/i18n/use-t.ts";
import {
  type CdnSummary,
  formatNumber,
} from "@/layouts/main-panel-tabs/cdn-tab";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { useProjectContext } from "@/sdk";
import { EMPTY_SEGMENT, useDecoView } from "./analytics/segment";
import { useAnalyticsStatus } from "./deco-analytics";
import type { SiteProject } from "./org-insights";
import { cdnQuery, shareOf } from "./performance-view";

type Destination =
  | { view: "audience"; section?: string }
  | { view: "performance" };

const rowsOf = (data: Record<string, unknown> | undefined, key: string) =>
  (Array.isArray(data?.[key]) ? data[key] : []) as Record<string, unknown>[];

/**
 * The site's health today beside its audience: conversion and browser errors
 * from Deco Analytics, server errors and latency from the CDN. Each card opens
 * the screen it comes from; a card nothing feeds is left out.
 */
export function SiteGlance({
  project,
  onOpen,
}: {
  project: SiteProject;
  onOpen: (to: Destination) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const status = useAnalyticsStatus(org.slug, project);
  const registered = status.data?.registered === true;
  const read = (view: string) => ({
    orgSlug: org.slug,
    site: project.site,
    view,
    range: "24h",
    segment: EMPTY_SEGMENT,
    enabled: registered,
  });
  const overview = useDecoView(read("overview")).data?.data;
  const errors = useDecoView(read("errors")).data?.data;
  const cdn = useQuery(
    cdnQuery<CdnSummary>(
      `/api/${org.slug}/monitor/${encodeURIComponent(project.analyticsSite)}`,
      "summary",
      "today",
    ),
  ).data;
  // A CDN that served nothing today has no latency or error rate to show.
  const served = cdn && cdn.total_requests > 0 ? cdn : null;

  const funnel = rowsOf(overview, "funnel")[0];
  const viewed = Number(funnel?.viewed) || 0;
  const bought = Number(funnel?.purchase) || 0;
  const errorRows = rowsOf(errors, "errors");
  const occurrences = errorRows.reduce(
    (n, r) => n + (Number(r.occurrences) || 0),
    0,
  );

  const cards = [
    funnel && viewed > 0 && (
      <MetricCard
        key="conversion"
        title={t("monitor.glance.conversion")}
        value={`${((100 * Math.min(bought, viewed)) / viewed).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
        caption={
          <span className="text-meta">
            {t("monitor.glance.purchases", { count: formatNumber(bought) })}
          </span>
        }
        onClick={() => onOpen({ view: "audience" })}
      />
    ),
    errors && (
      <MetricCard
        key="js-errors"
        title={t("monitor.glance.jsErrors")}
        value={formatNumber(occurrences)}
        caption={
          errorRows.length > 0 && (
            <span className="text-meta">
              {t("monitor.glance.errorKinds", {
                count: formatNumber(errorRows.length),
              })}
            </span>
          )
        }
        onClick={() => onOpen({ view: "audience", section: "errors" })}
      />
    ),
    served && (
      <MetricCard
        key="5xx"
        title={t("monitor.glance.serverErrors")}
        value={formatNumber(served.status_5xx_count)}
        caption={
          <span className="text-meta">
            {t("monitor.performance.errorShare", {
              share: shareOf(served.status_5xx_count, served.total_requests),
            })}
          </span>
        }
        onClick={() => onOpen({ view: "performance" })}
      />
    ),
    served && (
      <MetricCard
        key="latency"
        title={t("monitor.glance.latency")}
        value={`${Math.round(served.avg_latency_ms)} ms`}
        onClick={() => onOpen({ view: "performance" })}
      />
    ),
  ].filter(Boolean);

  if (cards.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
      {cards}
    </div>
  );
}
