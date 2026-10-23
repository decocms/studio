/**
 * Every project side by side at org scope: its status, today's orders
 * against yesterday, conversion, errors and its last deploy. A row opens the
 * project's own Monitor.
 */

import { useNavigate } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { SettingsSection } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";
import {
  formatCount,
  formatShare,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import type { ProjectRow } from "./board";
import { Change, projectLink, StatusDot } from "./parts";
import { Sparkline } from "./sparkline";

const DASH = <span className="text-meta">–</span>;

export function ProjectsTable({
  projects,
  orgSlug,
}: {
  projects: readonly ProjectRow[];
  orgSlug: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <SettingsSection title={t("monitor.projects.title")}>
      <div className="surface overflow-x-auto">
        <Table variant="flush">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">
                {t("monitor.projects.project")}
              </TableHead>
              <TableHead>{t("monitor.projects.orders")}</TableHead>
              <TableHead className="w-28" />
              <TableHead>{t("monitor.projects.conversion")}</TableHead>
              <TableHead>{t("monitor.projects.errors")}</TableHead>
              <TableHead>{t("monitor.projects.lastDeploy")}</TableHead>
              <TableHead className="pr-4 text-right">
                {t("monitor.projects.signals")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => (
              <TableRow
                key={project.id}
                className="cursor-pointer"
                onClick={() =>
                  void navigate(projectLink(orgSlug, project.id, "monitoring"))
                }
              >
                <TableCell className="pl-4">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <StatusDot status={project.status} />
                    {project.title}
                  </span>
                </TableCell>
                <TableCell>
                  {project.orders === null ? (
                    DASH
                  ) : (
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm tnum text-foreground">
                        {formatCount(Math.round(project.orders))}
                      </span>
                      <Change
                        change={relativeChange(
                          project.orders,
                          project.ordersPrevious,
                        )}
                        better="up"
                      />
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {project.ordersSeries && (
                    <Sparkline
                      values={project.ordersSeries}
                      className="h-6 w-24"
                    />
                  )}
                </TableCell>
                <TableCell className="text-sm tnum text-foreground">
                  {project.conversion === null
                    ? DASH
                    : formatShare(project.conversion)}
                </TableCell>
                <TableCell className="text-sm tnum text-foreground">
                  {project.errorRate === null
                    ? DASH
                    : formatShare(project.errorRate)}
                </TableCell>
                <TableCell className="max-w-64">
                  {project.lastDeploy ? (
                    <div className="flex flex-col">
                      <span className="truncate text-sm text-foreground">
                        {project.lastDeploy.message}
                      </span>
                      <span className="text-meta">
                        {formatTimeAgo(new Date(project.lastDeploy.at))}
                      </span>
                    </div>
                  ) : (
                    DASH
                  )}
                </TableCell>
                <TableCell className="pr-4 text-right text-sm tnum text-foreground">
                  {project.signals > 0 ? project.signals : DASH}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
}
