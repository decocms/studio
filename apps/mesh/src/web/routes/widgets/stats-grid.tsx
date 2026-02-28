import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type Stat = { label: string; value: string; unit?: string; trend?: number };
type StatsGridArgs = { stats?: Stat[] };

export default function StatsGrid() {
  const { args } = useWidget<StatsGridArgs>();

  if (!args) return null;

  const { stats = [] } = args;

  if (stats.length === 0) {
    return (
      <div className="p-4 font-sans text-sm text-muted-foreground text-center py-4">
        No stats
      </div>
    );
  }

  return (
    <div className="p-4 font-sans">
      <div className="grid grid-cols-2 gap-3">
        {stats.map((stat, i) => {
          const trendUp = (stat.trend ?? 0) > 0;
          const trendDown = (stat.trend ?? 0) < 0;
          return (
            <div key={i} className="bg-muted/50 rounded-lg p-3">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                {stat.label}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-foreground tabular-nums">
                  {stat.value}
                </span>
                {stat.unit && (
                  <span className="text-sm text-muted-foreground">
                    {stat.unit}
                  </span>
                )}
              </div>
              {stat.trend !== undefined && stat.trend !== 0 && (
                <div
                  className={cn(
                    "text-xs font-medium mt-1",
                    trendUp
                      ? "text-green-600"
                      : trendDown
                        ? "text-red-500"
                        : "text-muted-foreground",
                  )}
                >
                  {trendUp ? "▲" : "▼"} {trendUp ? "+" : ""}
                  {stat.trend}%
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
