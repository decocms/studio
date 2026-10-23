/**
 * Every monitored store with each rule's last verdict and its open tasks, as
 * the Settings Stores tab lists them. A row opens the store's day.
 */

import { Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { ORDER_MONITOR_RULES } from "@decocms/shared/order-monitor";
import { taskKey } from "@decocms/shared/task-key";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import { SettingsSection } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";
import { type MonitoredStore, storeStatus } from "./board";
import { MonitorStatusMark, StatusDot } from "./parts";

const DASH = <span className="text-meta">–</span>;

export function StoresTable({
  stores,
  orgSlug,
  onOpen,
}: {
  stores: readonly MonitoredStore[];
  orgSlug: string;
  onOpen: (connectionId: string) => void;
}) {
  const t = useT();
  return (
    <SettingsSection title={t("orderMonitor.storesTab")}>
      <div className="surface overflow-x-auto">
        <Table variant="flush">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t("orderMonitor.store")}</TableHead>
              {ORDER_MONITOR_RULES.map((rule) => (
                <TableHead key={rule}>{ruleLabel(rule, t)}</TableHead>
              ))}
              <TableHead className="pr-4">
                {t("orderMonitor.openTask")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stores.map(({ store }) => (
              <TableRow
                key={store.connectionId}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() => onOpen(store.connectionId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(store.connectionId);
                  }
                }}
              >
                <TableCell className="pl-4">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <StatusDot status={storeStatus(store)} />
                    {store.title}
                  </span>
                </TableCell>
                {ORDER_MONITOR_RULES.map((rule) => {
                  const state = store.rules.find((r) => r.rule === rule);
                  return (
                    <TableCell key={rule}>
                      {state ? (
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-2">
                            <MonitorStatusMark status={state.status} />
                            <span className="text-meta">
                              {t("orderMonitor.since", {
                                ago: formatTimeAgo(new Date(state.since)),
                              })}
                            </span>
                          </span>
                          <span className="text-meta tnum">
                            {t("orderMonitor.observedOfExpected", {
                              observed: state.verdict.observed,
                              expected: Math.round(state.verdict.expected),
                            })}
                          </span>
                        </div>
                      ) : (
                        DASH
                      )}
                    </TableCell>
                  );
                })}
                <TableCell className="pr-4">
                  {store.rules.some((r) => r.task) ? (
                    <div className="flex flex-col gap-1">
                      {store.rules.flatMap((r) => {
                        const key = r.task && taskKey(orgSlug, r.task.keySeq);
                        return r.task && key
                          ? [
                              <Link
                                key={r.task.id}
                                to="/$org/t/$taskKey"
                                params={{ org: orgSlug, taskKey: key }}
                                onClick={(e) => e.stopPropagation()}
                                className="text-sm font-medium text-foreground underline-offset-2 hover:underline"
                              >
                                {key}
                              </Link>,
                            ]
                          : [];
                      })}
                    </div>
                  ) : (
                    DASH
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
}
