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
  | { view: "audience"; section: string }
  | { view: "performance" };

const rowsOf = (data: Record<string, unknown> | undefined, key: string) =>
  (Array.isArray(data?.[key]) ? data[key] : []) as Record<string, unknown>[];

/** The errors view lists only the most frequent fingerprints (queries.mjs). */
const ERRORS_LISTED = 12;

/**
 * The site's health beside its audience: server errors and latency from the
 * CDN for the board's day, and browser errors from Deco Analytics, which reads
 * only rolling windows and so shows the last 24 hours and only on today's
 * board. Each card opens the screen it comes from; one nothing feeds is left out.
 */
export function SiteGlance({
  project,
  date,
  today,
  onOpen,
}: {
  project: SiteProject;
  /** The board's local day, `YYYY-MM-DD`. */
  date: string;
  today: boolean;
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
    enabled: registered && today,
  });
  const errors = useDecoView(read("errors")).data?.data;
  const events = useDecoView(read("events")).data?.data;
  const cdn = useQuery(
    cdnQuery<CdnSummary>(
      `/api/${org.slug}/monitor/${encodeURIComponent(project.analyticsSite)}`,
      "summary",
      "custom",
      `&since=${date}&until=${date}`,
    ),
  ).data;
  // A CDN that served nothing that day has no latency or error rate to show.
  const served = cdn && cdn.total_requests > 0 ? cdn : null;

  const errorRows = rowsOf(errors, "errors");
  const listedAll = errorRows.length < ERRORS_LISTED;
  // Every `$error`, from the events ranking; the fingerprints add up to the
  // total only when none were cut off.
  const counted = rowsOf(events, "events").find((r) => r.k === "$error");
  const listed = errorRows.reduce(
    (n, r) => n + (Number(r.occurrences) || 0),
    0,
  );
  const errorTotal = counted
    ? formatNumber(Number(counted.n) || 0)
    : listedAll
      ? formatNumber(listed)
      : `${formatNumber(listed)}+`;

  const cards = [
    today && errors && (
      <MetricCard
        key="js-errors"
        title={t("monitor.glance.jsErrors")}
        value={errorTotal}
        caption={
          errorRows.length > 0 && (
            <span className="text-meta">
              {t("monitor.glance.errorKinds", {
                count: listedAll
                  ? formatNumber(errorRows.length)
                  : `${ERRORS_LISTED}+`,
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
