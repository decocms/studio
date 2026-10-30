/**
 * The Analytics tab's headline numbers on the overview, against the prior
 * period when the source keeps one and with their shape when they have a
 * series. Deco Analytics reads only rolling windows, so the cards say 24 h and
 * stay off a past day's board. A card opens its section; one no source feeds
 * is left out.
 */

import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import { formatNumber } from "@/layouts/main-panel-tabs/cdn-tab";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { useProjectContext } from "@/sdk";
import {
  firstRow,
  fmtInt,
  fmtMoney,
  fmtPct,
  moneyOf,
  n0,
  num,
  PrevChange,
  ratioPct,
  rowsOf,
  str,
} from "./analytics/panels";
import { EMPTY_SEGMENT, useDecoView } from "./analytics/segment";
import { useAnalyticsStatus } from "./deco-analytics";
import type { SiteProject } from "./org-insights";
import { Sparkline } from "./sparkline";

export interface OverviewDestination {
  view: "audience" | "realtime";
}

/** Every overview card: the figure, one line under it, and its shape if any. */
function Stat({
  title,
  value,
  caption,
  values,
  onClick,
}: {
  title: string;
  value: ReactNode;
  caption?: ReactNode;
  values?: readonly number[];
  onClick: () => void;
}) {
  return (
    <MetricCard title={title} value={value} caption={caption} onClick={onClick}>
      {values && values.length > 1 && <Sparkline values={values} />}
    </MetricCard>
  );
}

function Row({ children }: { children: ReactNode[] }) {
  const cards = children.filter(Boolean);
  if (cards.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
      {cards}
    </div>
  );
}

/** One Deco Analytics view for the overview, read only on today's board. */
function useDeco(
  project: SiteProject,
  today: boolean,
  view: string,
  range = "24h",
) {
  const { org } = useProjectContext();
  const status = useAnalyticsStatus(org.slug, project);
  const registered = status.data?.registered === true && today;
  const data = useDecoView({
    orgSlug: org.slug,
    site: project.site,
    view,
    range,
    segment: EMPTY_SEGMENT,
    enabled: registered,
  }).data?.data;
  return registered ? data : undefined;
}

/** The Analytics tab at a glance: who is on the site and what they buy. */
export function AnalyticsGlance({
  project,
  today,
  withVisitors,
  onOpen,
}: {
  project: SiteProject;
  today: boolean;
  /** Off when the board already charts the site's visitors. */
  withVisitors: boolean;
  onOpen: (to: OverviewDestination) => void;
}) {
  const t = useT();
  const overview = useDeco(project, today, "overview");
  const live = useDeco(project, today, "live", "5m");

  const now = firstRow(live, "liveVisitors");
  const perMinute = rowsOf(live, "liveByMinute").map((r) => n0(r.visitors));
  const kpis = firstRow(overview, "kpis");
  const prev = firstRow(overview, "kpisPrev");
  const funnel = firstRow(overview, "funnel");
  const viewed = n0(funnel?.viewed);
  const purchases = n0(funnel?.purchase);
  const money = moneyOf(overview);
  const revenue = rowsOf(overview, "currencies").find(
    (c) => str(c.k) === money.currency,
  );
  const open = (view: OverviewDestination["view"] = "audience") =>
    onOpen({ view });

  return (
    <Row>
      {now && (
        <Stat
          key="now"
          title={t("monitor.analytics.live.visitorsNow")}
          value={fmtInt(now.visitors)}
          caption={
            <span className="text-meta">
              {t("monitor.overview.lastMinutes", {
                count: String(perMinute.length),
              })}
            </span>
          }
          values={perMinute}
          onClick={() => open("realtime")}
        />
      )}
      {withVisitors && kpis && (
        <Stat
          key="visitors"
          title={t("monitor.overview.visitors")}
          value={fmtInt(kpis.visitors)}
          caption={
            <PrevChange
              current={num(kpis.visitors)}
              previous={num(prev?.visitors)}
              covered={num(prev?.covered)}
              better="up"
            />
          }
          values={rowsOf(overview, "series").map((p) => n0(p.visitors))}
          onClick={() => open()}
        />
      )}
      {funnel && viewed > 0 && (
        <Stat
          key="conversion"
          title={t("monitor.overview.conversion")}
          value={fmtPct(ratioPct(purchases, viewed))}
          caption={
            <span className="text-meta">
              {t("monitor.overview.purchases", {
                count: formatNumber(purchases),
              })}
            </span>
          }
          onClick={() => open()}
        />
      )}
      {money.hasRevenue && revenue && (
        <Stat
          key="revenue"
          title={t("monitor.overview.revenue")}
          value={fmtMoney(revenue.revenue, money.currency)}
          caption={
            <span className="text-meta">
              {t("monitor.overview.perVisitor", {
                value: fmtMoney(
                  n0(revenue.revenue) / Math.max(1, n0(kpis?.visitors)),
                  money.currency,
                  2,
                ),
              })}
            </span>
          }
          onClick={() => open()}
        />
      )}
    </Row>
  );
}
