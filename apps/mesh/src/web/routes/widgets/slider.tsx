import { useState } from "react";
import { useWidget } from "./use-widget.ts";

type SliderArgs = {
  value?: number;
  min?: number;
  max?: number;
  label?: string;
};

export default function Slider() {
  const { args } = useWidget<SliderArgs>();
  const [current, setCurrent] = useState<number | null>(null);

  if (!args) return null;

  const { value = 50, min = 0, max = 100, label = "Slider" } = args;
  const displayValue = current !== null ? current : value;
  const pct = max > min ? ((displayValue - min) / (max - min)) * 100 : 0;

  return (
    <div className="p-4 font-sans">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm font-medium text-muted-foreground tabular-nums">
          {displayValue}
        </span>
      </div>
      <div className="relative flex items-center h-5">
        <div className="h-2 w-full rounded-full bg-muted relative">
          <div
            className="absolute h-2 rounded-full bg-primary"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          value={displayValue}
          onChange={(e) => setCurrent(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
        />
        <div
          className="absolute size-4 rounded-full bg-white border-2 border-primary shadow-sm -translate-x-1/2"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-xs text-muted-foreground tabular-nums">
          {min}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {max}
        </span>
      </div>
    </div>
  );
}
