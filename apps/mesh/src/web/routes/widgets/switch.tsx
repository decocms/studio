import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type SwitchArgs = { label?: string; description?: string; checked?: boolean };

export default function Switch() {
  const { args } = useWidget<SwitchArgs>();
  const [on, setOn] = useState<boolean | null>(null);

  if (!args) return null;

  const { label = "Toggle", description, checked = false } = args;
  const isOn = on !== null ? on : checked;

  return (
    <div className="p-4 font-sans flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-xs text-muted-foreground mt-0.5">
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        onClick={() => setOn(!isOn)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors",
          isOn ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "pointer-events-none block size-5 rounded-full bg-white shadow transition-transform",
            isOn ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
