/**
 * Every monitored store with each rule's last verdict, as the Settings Stores
 * tab lists them. A store reads as the project that sells through it; a rule
 * with an open task links it in place. A row opens the store's day.
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
import {
  ORDER_MONITOR_RULES,
  type OrderMonitorRuleState,
  type OrderMonitorStore,
} from "@decocms/shared/order-monitor";
import { taskKey } from "@decocms/shared/task-key";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ProjectIcon } from "@/components/project-icon";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import { SettingsSection } from "@/components/settings/settings-section";
import { usePreferences } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { formatRelativeTime } from "@/lib/format-time";
import { useVirtualMCPsNonBlocking } from "@/sdk";
import type { MonitoredStore } from "./board";
import { MonitorStatusMark } from "./parts";

/** The ingest's own title ends in a suffix the store's name doesn't need. */
const INGEST_SUFFIX = / · .*$/;

function StoreName({ store }: { store: OrderMonitorStore }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const project = useVirtualMCPsNonBlocking().find((p) =>
    store.agentIds.includes(p.id),
  );
  const title = project?.title ?? store.title.replace(INGEST_SUFFIX, "");
  const evaluated = store.rules
    .map((r) => r.evaluatedAt)
    .sort()
    .at(-1);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ProjectIcon icon={project?.icon} name={title} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {evaluated && (
          <span className="text-meta truncate">
            {t("orderMonitor.checked", {
              when: formatRelativeTime(new Date(evaluated), language),
            })}
          </span>
        )}
      </span>
    </span>
  );
}

function RuleCell({
  state,
  orgSlug,
}: {
  state: OrderMonitorRuleState | undefined;
  orgSlug: string;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  if (!state) return <span className="text-meta">–</span>;
  const expected = Math.round(state.verdict.expected);
  const key = state.task && taskKey(orgSlug, state.task.keySeq);
  const counts =
    state.verdict.observed === 0 && expected === 0
      ? t("orderMonitor.noneExpected")
      : t("orderMonitor.observedOfExpected", {
          observed: state.verdict.observed,
          expected,
        });
  const since =
    state.status === "ok"
      ? null
      : formatRelativeTime(new Date(state.since), language);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <MonitorStatusMark status={state.status} />
        {key && (
          <Link
            to="/$org/t/$taskKey"
            params={{ org: orgSlug, taskKey: key }}
            onClick={(e) => e.stopPropagation()}
            className="text-meta font-medium text-foreground underline-offset-2 hover:underline"
          >
            {key}
          </Link>
        )}
      </span>
      <span className="text-meta tnum">
        {since ? `${counts} · ${since}` : counts}
      </span>
    </div>
  );
}

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
              {ORDER_MONITOR_RULES.map((rule, i) => (
                <TableHead
                  key={rule}
                  className={cn(i === ORDER_MONITOR_RULES.length - 1 && "pr-4")}
                >
                  {ruleLabel(rule, t)}
                </TableHead>
              ))}
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
                  <StoreName store={store} />
                </TableCell>
                {ORDER_MONITOR_RULES.map((rule, i) => (
                  <TableCell
                    key={rule}
                    className={cn(
                      i === ORDER_MONITOR_RULES.length - 1 && "pr-4",
                    )}
                  >
                    <RuleCell
                      state={store.rules.find((r) => r.rule === rule)}
                      orgSlug={orgSlug}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
}
