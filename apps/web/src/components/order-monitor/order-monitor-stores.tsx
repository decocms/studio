/**
 * The org Monitoring page's Stores tab: one row per monitored store with each
 * rule's last verdict (from `order_monitor_state`, no lake query), and the
 * store's day once one is picked.
 */

import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
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
  type OrderMonitorStore,
} from "@decocms/shared/order-monitor";
import { taskKey } from "@decocms/shared/task-key";
import { formatTimeAgo } from "@/lib/format-time";
import { useT } from "@/i18n/use-t.ts";
import { useOrderMonitorStores } from "@/hooks/use-order-monitor";
import {
  OrderMonitorDayView,
  OrderMonitorStatusBadge,
  ruleLabel,
} from "./order-monitor-day";

function StoreRow({
  store,
  orgSlug,
  onSelect,
}: {
  store: OrderMonitorStore;
  orgSlug: string;
  onSelect: () => void;
}) {
  const t = useT();
  const openTasks = store.rules.flatMap((r) => (r.task ? [r.task] : []));
  return (
    <TableRow className="cursor-pointer" onClick={onSelect}>
      <TableCell className="font-medium text-foreground">
        {store.title}
      </TableCell>
      {ORDER_MONITOR_RULES.map((rule) => {
        const state = store.rules.find((r) => r.rule === rule);
        return (
          <TableCell key={rule}>
            {state ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <OrderMonitorStatusBadge status={state.status} />
                  <span className="text-xs text-muted-foreground">
                    {t("orderMonitor.since", {
                      ago: formatTimeAgo(new Date(state.since)),
                    })}
                  </span>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("orderMonitor.observedOfExpected", {
                    observed: state.verdict.observed,
                    expected: Math.round(state.verdict.expected),
                  })}
                </span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </TableCell>
        );
      })}
      <TableCell>
        {openTasks.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-1">
            {openTasks.map((task) => {
              const key = taskKey(orgSlug, task.keySeq);
              return key ? (
                <Link
                  key={task.id}
                  to="/$org/t/$taskKey"
                  params={{ org: orgSlug, taskKey: key }}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {key}
                </Link>
              ) : null;
            })}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function OrderMonitorStoresTab({
  orgSlug,
  store,
  at,
  onSelect,
}: {
  orgSlug: string;
  /** The selected store's connection id. */
  store: string | undefined;
  at: string | undefined;
  onSelect: (selection: { store?: string; at?: string }) => void;
}) {
  const t = useT();
  const storesQuery = useOrderMonitorStores(orgSlug, true);
  const stores = storesQuery.data ?? [];

  if (storesQuery.isLoading) {
    return <Skeleton className="m-4 h-40" />;
  }
  if (storesQuery.error) {
    return (
      <EmptyState
        title={t("orderMonitor.storesErrorTitle")}
        description={storesQuery.error.message}
      />
    );
  }

  const selected = store
    ? stores.find((s) => s.connectionId === store)
    : undefined;
  if (store) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-1 pb-6 md:px-10">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelect({})}
            className="gap-1"
          >
            <ArrowLeft className="size-4" />
            {t("orderMonitor.allStores")}
          </Button>
          <h2 className="text-base font-semibold text-foreground">
            {selected?.title ?? store}
          </h2>
        </div>
        <OrderMonitorDayView
          orgSlug={orgSlug}
          connectionId={store}
          at={at}
          onAtChange={(next) => onSelect({ store, at: next })}
        />
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <EmptyState
        title={t("orderMonitor.noStoresTitle")}
        description={t("orderMonitor.noStoresBody")}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] overflow-auto px-4 pt-1 pb-6 md:px-10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("orderMonitor.store")}</TableHead>
            {ORDER_MONITOR_RULES.map((rule) => (
              <TableHead key={rule}>{ruleLabel(rule, t)}</TableHead>
            ))}
            <TableHead>{t("orderMonitor.openTask")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stores.map((s) => (
            <StoreRow
              key={s.connectionId}
              store={s}
              orgSlug={orgSlug}
              onSelect={() => onSelect({ store: s.connectionId })}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
