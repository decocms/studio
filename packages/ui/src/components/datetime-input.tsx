"use client";

import * as React from "react";
import { Calendar } from "@deco/ui/components/calendar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Calendar as CalendarIcon } from "@untitledui/icons";
import {
  expressionToDate,
  isTimeExpression,
} from "@deco/ui/lib/time-expressions.ts";

export interface DateTimeInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  error?: string;
}

/**
 * Format a date for display: "2022-05-01 02:00:00"
 */
function formatDisplayDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Parse a display date back to ISO: "2022-05-01 02:00:00" -> ISO string
 */
function parseDisplayDate(input: string): Date | null {
  // Match format: YYYY-MM-DD HH:MM:SS
  const match = input.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) return null;

  const [, year, month, day, hours, minutes, seconds] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );

  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Get display value: show "now-2d" for expressions, "2022-05-01 02:00:00" for dates
 */
function getDisplayValue(value: string): string {
  // If it's a time expression like "now" or "now-2d", show as-is
  if (isTimeExpression(value)) {
    return value;
  }

  // Otherwise, try to parse as date and format nicely
  const result = expressionToDate(value);
  if (result.valid && result.date) {
    return formatDisplayDate(result.date);
  }

  return value;
}

export function DateTimeInput({
  value,
  onChange,
  placeholder = "now or now-2d",
  className,
  disabled,
  error,
}: DateTimeInputProps) {
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState(() =>
    getDisplayValue(value),
  );
  const [localError, setLocalError] = React.useState<string | undefined>();
  const [isFocused, setIsFocused] = React.useState(false);

  // Sync input value when prop changes, but only if not focused (action during render)
  const prevValueRef = React.useRef(value);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevValueRef.current !== value) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevValueRef.current = value;
    if (!isFocused) {
      setInputValue(getDisplayValue(value));
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    // Clear error while typing - we'll validate on blur
    setLocalError(undefined);
  };

  const handleInputFocus = () => {
    setIsFocused(true);
  };

  const handleInputBlur = () => {
    setIsFocused(false);

    // Try to parse and commit the value
    const trimmed = inputValue.trim();

    // Try as time expression first (now, now-2d, etc.)
    if (isTimeExpression(trimmed)) {
      setLocalError(undefined);
      onChange(trimmed);
      return;
    }

    // Try as display format date (2024-12-19 14:00:00)
    const parsedDate = parseDisplayDate(trimmed);
    if (parsedDate) {
      setLocalError(undefined);
      onChange(parsedDate.toISOString());
      setInputValue(formatDisplayDate(parsedDate));
      return;
    }

    // Try as ISO or other date format
    const result = expressionToDate(trimmed);
    if (result.valid && result.date) {
      setLocalError(undefined);
      onChange(trimmed);
      setInputValue(formatDisplayDate(result.date));
      return;
    }

    // Invalid - revert to last valid value
    setInputValue(getDisplayValue(value));
    setLocalError(undefined);
  };

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      // Get the current time from the existing value or use current time
      const currentResult = expressionToDate(value);
      const currentDate = currentResult.date || new Date();

      // Combine selected date with current time
      date.setHours(currentDate.getHours());
      date.setMinutes(currentDate.getMinutes());
      date.setSeconds(0);
      date.setMilliseconds(0);

      const isoValue = date.toISOString();
      setInputValue(formatDisplayDate(date));
      onChange(isoValue);
      setLocalError(undefined);
    }
    setCalendarOpen(false);
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const [hours, minutes] = e.target.value.split(":").map(Number);
    const result = expressionToDate(value);
    const date = result.date || new Date();

    date.setHours(hours || 0);
    date.setMinutes(minutes || 0);
    date.setSeconds(0);
    date.setMilliseconds(0);

    const isoValue = date.toISOString();
    setInputValue(formatDisplayDate(date));
    onChange(isoValue);
  };

  // Get current date for calendar
  const currentResult = expressionToDate(value);
  const currentDate = currentResult.valid ? currentResult.date : new Date();

  // Get time value for time input
  const timeValue = currentDate
    ? `${String(currentDate.getHours()).padStart(2, "0")}:${String(currentDate.getMinutes()).padStart(2, "0")}`
    : "";

  const displayError = error || localError;

  return (
    <div className={cn("flex gap-1", className)}>
      <div className="flex-1 relative">
        <Input
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "text-sm h-8",
            displayError && "border-destructive focus-visible:ring-destructive",
          )}
        />
        {displayError && (
          <p className="text-xs text-destructive mt-1">{displayError}</p>
        )}
      </div>
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={disabled}
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            selected={currentDate || undefined}
            onSelect={handleDateSelect}
            initialFocus
          />
          <div className="border-t p-3">
            <label className="text-xs text-muted-foreground mb-1.5 block">
              Time
            </label>
            <Input
              type="time"
              value={timeValue}
              onChange={handleTimeChange}
              className="text-sm h-8"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
