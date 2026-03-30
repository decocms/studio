"use client";

import * as React from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Clock, ChevronDown } from "@untitledui/icons";
import { DateTimeInput } from "@deco/ui/components/datetime-input.tsx";
import {
  QUICK_RANGES,
  expressionToDate,
  getTimeRangeDisplayText,
  type QuickRange,
} from "@deco/ui/lib/time-expressions.ts";

export interface TimeRange {
  from: string;
  to: string;
}

export interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
  className?: string;
  disabled?: boolean;
  /** Quick ranges to display. Defaults to QUICK_RANGES */
  quickRanges?: QuickRange[];
}

export function TimeRangePicker({
  value,
  onChange,
  className,
  disabled,
  quickRanges = QUICK_RANGES,
}: TimeRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [localFrom, setLocalFrom] = React.useState(value.from);
  const [localTo, setLocalTo] = React.useState(value.to);
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );

  // Sync local state when prop changes (action during render)
  const prevValueRef = React.useRef({ from: value.from, to: value.to });
  if (
    prevValueRef.current.from !== value.from ||
    prevValueRef.current.to !== value.to
  ) {
    prevValueRef.current = { from: value.from, to: value.to };
    setLocalFrom(value.from);
    setLocalTo(value.to);
  }

  const handleQuickRangeSelect = (range: QuickRange) => {
    onChange({ from: range.from, to: range.to });
    setOpen(false);
  };

  const handleApply = () => {
    // Validate that from is before to
    const fromResult = expressionToDate(localFrom);
    const toResult = expressionToDate(localTo);

    if (!fromResult.valid || !fromResult.date) {
      setValidationError("Invalid 'From' date");
      return;
    }

    if (!toResult.valid || !toResult.date) {
      setValidationError("Invalid 'To' date");
      return;
    }

    if (fromResult.date >= toResult.date) {
      setValidationError("'From' must be before 'To'");
      return;
    }

    setValidationError(null);
    onChange({ from: localFrom, to: localTo });
    setOpen(false);
  };

  // Check if current value matches a quick range
  const isQuickRangeSelected = (range: QuickRange) => {
    return value.from === range.from && value.to === range.to;
  };

  const displayText = getTimeRangeDisplayText(value.from, value.to);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("gap-1.5 min-w-[160px] justify-between", className)}
          disabled={disabled}
        >
          <div className="flex items-center gap-1.5">
            <Clock className="size-4 text-muted-foreground" />
            <span className="text-sm">{displayText}</span>
          </div>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[540px] p-0" align="end" sideOffset={4}>
        <div className="flex">
          {/* Left: Absolute time range */}
          <div className="flex-1 p-4 border-r">
            <h4 className="text-sm font-medium mb-4">Absolute time range</h4>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">
                  From
                </label>
                <DateTimeInput
                  value={localFrom}
                  onChange={setLocalFrom}
                  placeholder="now-24h"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">
                  To
                </label>
                <DateTimeInput
                  value={localTo}
                  onChange={setLocalTo}
                  placeholder="now"
                />
              </div>

              {validationError && (
                <p className="text-xs text-destructive">{validationError}</p>
              )}

              <Button onClick={handleApply} className="w-full" size="sm">
                Apply time range
              </Button>
            </div>
          </div>

          {/* Right: Quick ranges */}
          <div className="w-[200px]">
            <ScrollArea className="h-[280px]">
              <div className="p-2">
                {quickRanges.map((range) => {
                  const isSelected = isQuickRangeSelected(range);
                  return (
                    <button
                      key={range.value}
                      type="button"
                      onClick={() => handleQuickRangeSelect(range)}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm rounded-md transition-colors",
                        "hover:bg-accent hover:text-accent-foreground",
                        isSelected &&
                          "bg-accent text-accent-foreground font-medium",
                      )}
                    >
                      {range.label}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
