import { useT } from "@/i18n/use-t.ts";
import { formatNumber } from "@/layouts/main-panel-tabs/cdn-tab";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import type { SiteProject } from "../org-insights";
import { useAnalyticsStatus } from "../deco-analytics";
import { Sparkline } from "../sparkline";
import { EMPTY_SEGMENT, useDecoView } from "./segment";

/** Visitors on the site right now, beside the day's numbers; Deco Analytics only. */
export function LiveNowGlance({
  orgSlug,
  project,
  onOpen,
}: {
  orgSlug: string;
  project: SiteProject;
  onOpen: () => void;
}) {
  const t = useT();
  const status = useAnalyticsStatus(orgSlug, project);
  const live = useDecoView({
    orgSlug,
    site: project.site,
    view: "live",
    range: "5m",
    segment: EMPTY_SEGMENT,
    enabled: status.data?.registered === true,
  });
  const data = live.data?.data;
  const now = Array.isArray(data?.liveVisitors)
    ? (data.liveVisitors[0] as { visitors?: unknown } | undefined)
    : undefined;
  if (!status.data?.registered || !now) return null;
  const perMinute = Array.isArray(data?.liveByMinute)
    ? (data.liveByMinute as Array<{ visitors?: unknown }>).map(
        (r) => Number(r.visitors) || 0,
      )
    : [];
  return (
    <MetricCard
      title={t("monitor.analytics.live.visitorsNow")}
      value={formatNumber(Number(now.visitors) || 0)}
      onClick={onOpen}
    >
      {perMinute.length > 1 && <Sparkline values={perMinute} />}
    </MetricCard>
  );
}
