import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type MetricArgs = {
  label?: string;
  value?: number;
  unit?: string;
  trend?: number;
};

export default function Metric() {
  const { args } = useWidget<MetricArgs>();

  if (!args) return null;

  const { label = "Metric", value = 0, unit = "", trend = 0 } = args;
  const trendUp = trend > 0;
  const trendDown = trend < 0;

  return (
    <div className="p-4 font-sans">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="flex items-baseline gap-1 mb-1">
        <span className="text-4xl font-bold text-foreground tabular-nums">
          {value}
        </span>
        {unit && (
          <span className="text-lg font-medium text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {trend !== 0 && (
        <div
          className={cn(
            "text-sm font-medium flex items-center gap-1",
            trendUp
              ? "text-green-600"
              : trendDown
                ? "text-red-500"
                : "text-muted-foreground",
          )}
        >
          <span>{trendUp ? "▲" : "▼"}</span>
          <span>
            {trendUp ? "+" : ""}
            {trend}%
          </span>
        </div>
      )}
    </div>
  );
}
