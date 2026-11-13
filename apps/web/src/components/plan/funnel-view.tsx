/**
 * CRO as the store's funnel: how many sessions reach each step, where the
 * biggest share is lost, and which page to open to see why.
 */

import { AlertTriangle, ArrowDown, ChevronRight } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import type { MapNode } from "./site-map-mock.ts";

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Stages grouped by step, in funnel order. */
function stepsOf(stages: MapNode[]): MapNode[][] {
  const steps = new Map<number, MapNode[]>();
  for (const stage of stages) {
    const step = stage.step ?? steps.size + 1;
    steps.set(step, [...(steps.get(step) ?? []), stage]);
  }
  return [...steps.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group);
}

function StageCell({
  stage,
  top,
  selected,
  onSelect,
}: {
  stage: MapNode;
  top: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const value = stage.sessions ?? 0;
  const share = top ? value / top : 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(stage.id)}
      aria-pressed={selected}
      className={cn(
        "group flex min-w-0 flex-1 flex-col gap-3 surface surface-interactive p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-foreground",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {stage.label}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("plan.funnel.sessionsPeriod", {
              count: new Intl.NumberFormat(language).format(value),
            })}
          </span>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <div className="relative flex h-6 items-center">
        <div
          className="h-full rounded-[4px] bg-chart-1"
          style={{
            // Leaves room for the share label beside the longest bar.
            width: `calc((100% - 6rem) * ${Math.max(share, 0.01)})`,
          }}
        />
        <span className="ml-2 shrink-0 text-xs whitespace-nowrap tabular-nums text-muted-foreground">
          {t("plan.funnel.ofTotal", { rate: percent(share) })}
        </span>
      </div>
    </button>
  );
}

export function FunnelView({
  funnel,
  selectedId,
  compact,
  onSelect,
}: {
  funnel: MapNode;
  selectedId: string;
  /** Narrow, beside an open stage. */
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const count = new Intl.NumberFormat(language);
  const steps = stepsOf(funnel.children ?? []);
  const totals = steps.map((group) =>
    group.reduce((sum, stage) => sum + (stage.sessions ?? 0), 0),
  );
  const top = totals[0] ?? 0;
  const last = totals[totals.length - 1] ?? 0;
  const orders = funnel.orders ?? 0;
  const rates = totals.map((value, index) =>
    index === 0 ? 1 : value / (totals[index - 1] || 1),
  );
  const worst = rates.reduce(
    (worstIndex, rate, index) =>
      index > 0 && rate < (rates[worstIndex] ?? 1) ? index : worstIndex,
    1,
  );

  const transition = (rate: number, isWorst: boolean) => (
    <div className="flex h-9 items-center gap-2 pl-4 text-xs text-muted-foreground">
      <ArrowDown size={14} className="text-subtle-foreground" />
      {isWorst ? (
        <Badge variant="destructive">
          <AlertTriangle />
          {t("plan.funnel.biggestLoss", { rate: percent(1 - rate) })}
        </Badge>
      ) : (
        t("plan.funnel.advance", { rate: percent(rate) })
      )}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex flex-col gap-6 py-6",
          compact ? "px-4" : "max-w-4xl px-6",
        )}
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">
            {t("plan.funnel.conversion")}
          </span>
          <span className="text-4xl font-medium tabular-nums text-foreground">
            {new Intl.NumberFormat(language, {
              maximumFractionDigits: 1,
            }).format((top ? orders / top : 0) * 100)}
            %
          </span>
          <span className="text-sm text-muted-foreground">
            {t("plan.funnel.summary", {
              orders: count.format(orders),
              sessions: count.format(top),
            })}
          </span>
        </div>
        <ol className="flex flex-col">
          {steps.map((group, index) => (
            <li key={group.map((stage) => stage.id).join("+")}>
              {index > 0 && transition(rates[index] ?? 1, index === worst)}
              <div
                className={cn(
                  "flex gap-3",
                  compact && group.length > 1 && "flex-col",
                )}
              >
                {group.map((stage) => (
                  <StageCell
                    key={stage.id}
                    stage={stage}
                    top={top}
                    selected={stage.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </li>
          ))}
          <li>
            {transition(last ? orders / last : 0, false)}
            <div className="flex items-center justify-between surface p-4">
              <span className="text-sm font-medium text-foreground">
                {t("plan.funnel.orders")}
              </span>
              <span className="text-sm tabular-nums text-muted-foreground">
                {t("plan.funnel.ordersPeriod", {
                  count: count.format(orders),
                })}
              </span>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}
