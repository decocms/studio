/**
 * Today's deploys next to what they did: orders, errors and response time in
 * the hour after against the hour before, and a verdict. A regression offers
 * the rollback (or its task, once one is open); a fresh deploy says when its
 * hour will be measured.
 */

import { Link } from "@tanstack/react-router";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { taskKey } from "@decocms/shared/task-key";
import { SettingsSection } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";
import type { Deploy, DeployVerdict, ImpactMetric } from "./board";
import {
  Change,
  fmtTime,
  minutesSince,
  minutesUntil,
  projectLink,
} from "./parts";
import { metricLabel } from "./signals-panel";
import { Sparkline } from "./sparkline";

const BETTER: Record<ImpactMetric, "up" | "down"> = {
  orders: "up",
  errors: "down",
  latency: "down",
};

function VerdictBadge({ verdict }: { verdict: DeployVerdict }) {
  const t = useT();
  switch (verdict) {
    case "regression":
      return (
        <Badge variant="destructive">{t("monitor.verdict.regression")}</Badge>
      );
    case "improvement":
      return (
        <Badge variant="success">{t("monitor.verdict.improvement")}</Badge>
      );
    case "neutral":
      return <Badge variant="muted">{t("monitor.verdict.neutral")}</Badge>;
    case "settling":
      return <Badge variant="muted">{t("monitor.verdict.settling")}</Badge>;
    case "unmeasured":
      return <Badge variant="muted">{t("monitor.verdict.unmeasured")}</Badge>;
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}

function Action({ deploy, orgSlug }: { deploy: Deploy; orgSlug: string }) {
  const t = useT();
  const key = deploy.task ? taskKey(orgSlug, deploy.task.keySeq) : null;
  if (key) {
    return (
      <Button asChild variant="secondary" size="sm">
        <Link to="/$org/t/$taskKey" params={{ org: orgSlug, taskKey: key }}>
          {key}
        </Link>
      </Button>
    );
  }
  if (deploy.verdict === "regression" && deploy.projectId) {
    return (
      <Button asChild variant="secondary" size="sm">
        <Link {...projectLink(orgSlug, deploy.projectId, "releases")}>
          {t("monitor.action.revert")}
        </Link>
      </Button>
    );
  }
  return null;
}

export function DeploysTable({
  deploys,
  orgSlug,
  showProject,
}: {
  deploys: readonly Deploy[];
  orgSlug: string;
  showProject: boolean;
}) {
  const t = useT();
  return (
    <SettingsSection description={t("monitor.deploys.caption")}>
      {deploys.length === 0 ? (
        <p className="surface px-4 py-4 text-sm text-muted-foreground">
          {t("monitor.deploys.empty")}
        </p>
      ) : (
        <div className="surface overflow-x-auto">
          <Table variant="flush">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">
                  {t("monitor.deploys.when")}
                </TableHead>
                {showProject && (
                  <TableHead>{t("monitor.deploys.project")}</TableHead>
                )}
                <TableHead>{t("monitor.deploys.change")}</TableHead>
                <TableHead>{t("monitor.deploys.effect")}</TableHead>
                <TableHead>{t("monitor.deploys.verdict")}</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deploys.map((deploy) => (
                <TableRow key={deploy.id}>
                  <TableCell className="pl-4 align-top">
                    <span
                      className="whitespace-nowrap text-sm tnum text-foreground"
                      title={fmtTime(deploy.at)}
                    >
                      {formatTimeAgo(new Date(deploy.at))}
                    </span>
                  </TableCell>
                  {showProject && (
                    <TableCell className="align-top text-sm text-foreground">
                      {deploy.projectTitle}
                    </TableCell>
                  )}
                  <TableCell className="max-w-80 align-top">
                    <div className="flex flex-col">
                      <span className="truncate text-sm font-medium text-foreground">
                        {deploy.message}
                      </span>
                      <span className="text-meta">
                        {deploy.kind === "rollout"
                          ? `${t("monitor.chart.rollout")} · ${deploy.author}`
                          : deploy.author}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    {deploy.verdict === "settling" ? (
                      <span className="text-meta">
                        {t("monitor.deploys.measuring", {
                          minutes: Math.max(
                            1,
                            deploy.settlesAt
                              ? minutesUntil(deploy.settlesAt)
                              : 60 - minutesSince(deploy.at),
                          ),
                        })}
                      </span>
                    ) : (
                      <div className="flex items-center gap-4">
                        {deploy.around && (
                          <Sparkline
                            values={deploy.around}
                            marker={Math.floor(deploy.around.length / 2)}
                            tone={
                              deploy.verdict === "regression"
                                ? "bad"
                                : "neutral"
                            }
                            className="h-7 w-24 shrink-0"
                          />
                        )}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          {deploy.impact.map((impact) => (
                            <span
                              key={impact.metric}
                              className="flex items-baseline gap-1"
                            >
                              <span className="text-meta">
                                {metricLabel(impact.metric, t)}
                              </span>
                              <Change
                                change={impact.change}
                                better={BETTER[impact.metric]}
                              />
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <VerdictBadge verdict={deploy.verdict} />
                  </TableCell>
                  <TableCell className="pr-4 text-right align-top">
                    <Action deploy={deploy} orgSlug={orgSlug} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsSection>
  );
}
