import { useWidget } from "./use-widget.ts";

type ProgressArgs = { label?: string; value?: number; max?: number };

export default function Progress() {
  const { args } = useWidget<ProgressArgs>();

  if (!args) return null;

  const { label = "Progress", value = 0, max = 100 } = args;
  const pct = max > 0 ? Math.min(Math.round((value / max) * 100), 100) : 0;

  return (
    <div className="p-4 font-sans">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm font-medium text-muted-foreground tabular-nums">
          {pct}%
        </span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground mt-1 tabular-nums">
        {value} / {max}
      </div>
    </div>
  );
}
