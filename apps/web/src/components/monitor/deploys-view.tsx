/** The Deploys tab: what shipped, what it did to the numbers, and the ones still being measured. */

import { useT } from "@/i18n/use-t.ts";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import type { Deploy } from "./board";
import { DeployTimeline } from "./deploy-timeline";
import { DeploysTable } from "./deploys-table";

export function DeploysView({
  deploys,
  history,
  orgSlug,
  scopeId,
}: {
  deploys: readonly Deploy[];
  history: readonly Deploy[] | null;
  orgSlug: string;
  scopeId: string | null;
}) {
  const t = useT();
  const regressions = deploys.filter((d) => d.verdict === "regression").length;
  const measuring = deploys.filter((d) => d.verdict === "settling").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard title={t("monitor.deploys.title")} value={deploys.length} />
        <MetricCard
          title={t("monitor.deploys.regressions")}
          value={regressions}
          caption={
            regressions > 0 && (
              <span className="text-meta text-destructive">
                {t("monitor.deploys.regressionsHint")}
              </span>
            )
          }
        />
        <MetricCard
          title={t("monitor.deploys.measuringCount")}
          value={measuring}
        />
      </div>
      {history && <DeployTimeline deploys={history} showProject={!scopeId} />}
      <div className="mt-6">
        <DeploysTable
          deploys={deploys}
          orgSlug={orgSlug}
          showProject={!scopeId}
        />
      </div>
    </div>
  );
}
