import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type TodoItem = { text: string; completed?: boolean };
type TodoArgs = { items?: TodoItem[]; title?: string };

export default function Todo() {
  const { args } = useWidget<TodoArgs>();
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  if (!args) return null;

  const { items = [], title = "Todo" } = args;

  function toggle(i: number) {
    setChecked((prev) => ({ ...prev, [i]: !isChecked(i) }));
  }

  function isChecked(i: number): boolean {
    return i in checked ? (checked[i] ?? false) : !!items[i]?.completed;
  }

  const done = items.filter((_, i) => isChecked(i)).length;

  return (
    <div className="p-4 font-sans">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {done}/{items.length}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-2">
          No items
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggle(i)}
                className={cn(
                  "size-4 shrink-0 rounded border flex items-center justify-center transition-colors",
                  isChecked(i)
                    ? "bg-primary border-primary text-primary-foreground"
                    : "border-border bg-background",
                )}
              >
                {isChecked(i) && (
                  <svg
                    className="size-2.5"
                    viewBox="0 0 10 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M1 4l3 3 5-5" />
                  </svg>
                )}
              </button>
              <span
                className={cn(
                  "text-sm transition-colors",
                  isChecked(i)
                    ? "line-through text-muted-foreground"
                    : "text-foreground",
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
