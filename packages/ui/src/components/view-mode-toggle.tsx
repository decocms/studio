import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";

export interface ViewModeOption<T extends string = string> {
  value: T;
  icon: ReactNode;
  label?: string;
  tooltip?: string;
}

type ViewModeSize = "sm" | "md" | "lg";

interface ViewModeToggleProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ViewModeOption<T>[];
  size?: ViewModeSize;
  fullWidth?: boolean;
  className?: string;
}

const sizeConfig = {
  sm: {
    button: "size-7",
    icon: "size-4",
  },
  md: {
    button: "size-9",
    icon: "size-5",
  },
  lg: {
    button: "size-12",
    icon: "size-6",
  },
};

export function ViewModeToggle<T extends string = string>({
  value,
  onValueChange,
  options,
  size = "sm",
  fullWidth = false,
  className,
}: ViewModeToggleProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicatorPosition, setIndicatorPosition] = useState({
    left: 0,
    width: 0,
    opacity: 0,
  });

  const updateIndicator = (index: number) => {
    const el = refs.current[index];
    if (!el) return;
    setIndicatorPosition({
      left: el.offsetLeft,
      width: el.offsetWidth,
      opacity: 1,
    });
  };

  // Initialize indicator position based on current value
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const idx = options.findIndex((o) => o.value === value);
    if (idx >= 0) updateIndicator(idx);
  }, [value, options]);

  const config = sizeConfig[size];

  return (
    <div className={cn("relative flex gap-0 bg-muted rounded-lg", className)}>
      {options.map((option, i) => {
        const btn = (
          <button
            ref={(el) => {
              refs.current[i] = el;
            }}
            key={option.value}
            type="button"
            onClick={() => onValueChange(option.value)}
            className={cn(
              "relative z-10 flex items-center justify-center gap-2 rounded-lg transition-colors [transition-timing-function:var(--ease-out-cubic)] duration-200",
              fullWidth ? "flex-1 h-12 px-4" : config.button,
              !fullWidth && option.label ? "px-3" : "",
            )}
          >
            <span
              className={cn(
                "transition-colors ease-out duration-200 flex items-center justify-center [&>svg]:size-[1em]",
                config.icon,
                value === option.value
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {option.icon}
            </span>
            {option.label && (
              <span
                className={cn(
                  "text-xs transition-colors ease-out duration-200 whitespace-nowrap",
                  value === option.value
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {option.label}
              </span>
            )}
          </button>
        );
        if (!option.tooltip) return btn;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{btn}</TooltipTrigger>
            <TooltipContent side="bottom">{option.tooltip}</TooltipContent>
          </Tooltip>
        );
      })}
      {/* Sliding indicator */}
      <div
        className={cn(
          "absolute z-0 bg-background rounded-lg border-shadow transition-all [transition-timing-function:var(--ease-out-cubic)] duration-200",
          fullWidth ? "h-12" : config.button,
        )}
        style={{
          left: `${indicatorPosition.left}px`,
          width: `${indicatorPosition.width}px`,
          opacity: indicatorPosition.opacity,
        }}
      />
    </div>
  );
}
