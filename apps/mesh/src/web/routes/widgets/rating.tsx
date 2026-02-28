import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type RatingArgs = { value?: number; max?: number; label?: string };

export default function Rating() {
  const { args } = useWidget<RatingArgs>();
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  if (!args) return null;

  const { value = 0, max = 5, label = "Rating" } = args;
  const current = selected !== null ? selected : value;
  const display = hovered !== null ? hovered : current;

  return (
    <div className="p-4 font-sans">
      <div className="text-sm font-medium text-foreground mb-2">{label}</div>
      <div className="flex items-center gap-1">
        {Array.from({ length: max }, (_, i) => i + 1).map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => setSelected(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(null)}
            className={cn(
              "text-xl transition-colors hover:scale-110",
              star <= display ? "text-yellow-400" : "text-muted-foreground/30",
            )}
          >
            ★
          </button>
        ))}
        <span className="text-sm text-muted-foreground ml-2 tabular-nums">
          {current}/{max}
        </span>
      </div>
    </div>
  );
}
