import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";

type ScheduleUnit = "day" | "weekdays" | "week" | "month" | "year" | "custom";

interface CronScheduleSelectorProps {
  value: string;
  onChange: (cronExpression: string) => void;
  disabled?: boolean;
}

const DAYS = [
  { value: 1, short: "Mon" },
  { value: 2, short: "Tue" },
  { value: 3, short: "Wed" },
  { value: 4, short: "Thu" },
  { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
  { value: 0, short: "Sun" },
];

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
];

interface ParsedSchedule {
  unit: ScheduleUnit;
  hour: number;
  minute: number;
  selectedDays: number[];
  dayOfMonth: number;
  month: number;
}

function parseDayOfWeek(dow: string): number[] {
  const days: number[] = [];
  for (const part of dow.split(",")) {
    if (part.includes("-")) {
      const range = part.split("-").map(Number);
      const start = range[0];
      const end = range[1];
      if (
        start !== undefined &&
        end !== undefined &&
        Number.isInteger(start) &&
        Number.isInteger(end)
      ) {
        for (let i = start; i <= end; i++) days.push(i);
      }
    } else {
      const n = Number(part);
      if (Number.isInteger(n)) days.push(n);
    }
  }
  return days;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function parseCronExpression(value: string): ParsedSchedule {
  const defaults: ParsedSchedule = {
    unit: "custom",
    hour: 9,
    minute: 0,
    selectedDays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    month: 1,
  };

  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return defaults;

  const minutePart = parts[0]!;
  const hourPart = parts[1]!;
  const domPart = parts[2]!;
  const monthPart = parts[3]!;
  const dowPart = parts[4]!;
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  const validTime =
    Number.isInteger(minute) &&
    Number.isInteger(hour) &&
    minute >= 0 &&
    minute <= 59 &&
    hour >= 0 &&
    hour <= 23;

  if (!validTime) return defaults;

  const base = { hour, minute };

  // Yearly: MM HH DD MM *
  if (dowPart === "*" && monthPart !== "*" && domPart !== "*") {
    const month = Number(monthPart);
    const day = Number(domPart);
    if (
      Number.isInteger(month) &&
      month >= 1 &&
      month <= 12 &&
      Number.isInteger(day) &&
      day >= 1 &&
      day <= 31
    ) {
      return {
        ...base,
        unit: "year",
        selectedDays: [],
        dayOfMonth: day,
        month,
      };
    }
  }

  // Daily: MM HH * * *
  if (domPart === "*" && dowPart === "*" && monthPart === "*") {
    return { ...base, unit: "day", selectedDays: [], dayOfMonth: 1, month: 1 };
  }

  // Weekly variants: MM HH * * dow
  if (domPart === "*" && dowPart !== "*" && monthPart === "*") {
    const days = parseDayOfWeek(dowPart);
    if (days.length > 0) {
      // Check if it's exactly weekdays
      const isWeekdays = arraysEqual(days, [1, 2, 3, 4, 5]);
      return {
        ...base,
        unit: isWeekdays ? "weekdays" : "week",
        selectedDays: days,
        dayOfMonth: 1,
        month: 1,
      };
    }
  }

  // Monthly: MM HH DD * *
  if (dowPart === "*" && domPart !== "*" && monthPart === "*") {
    const day = Number(domPart);
    if (Number.isInteger(day) && day >= 1 && day <= 31) {
      return {
        ...base,
        unit: "month",
        selectedDays: [],
        dayOfMonth: day,
        month: 1,
      };
    }
  }

  return { ...defaults, hour, minute };
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildCron(schedule: ParsedSchedule): string {
  const { minute, hour } = schedule;
  if (schedule.unit === "day") {
    return `${minute} ${hour} * * *`;
  }
  if (schedule.unit === "weekdays") {
    return `${minute} ${hour} * * 1-5`;
  }
  if (schedule.unit === "week") {
    const dow =
      schedule.selectedDays.length > 0
        ? schedule.selectedDays.sort((a, b) => a - b).join(",")
        : "1-5";
    return `${minute} ${hour} * * ${dow}`;
  }
  if (schedule.unit === "month") {
    return `${minute} ${hour} ${schedule.dayOfMonth} * *`;
  }
  if (schedule.unit === "year") {
    return `${minute} ${hour} ${schedule.dayOfMonth} ${schedule.month} *`;
  }
  return `${minute} ${hour} * * *`;
}

export function CronScheduleSelector({
  value,
  onChange,
  disabled = false,
}: CronScheduleSelectorProps) {
  const parsed = parseCronExpression(value);

  // Local override so "Custom" sticks even when the cron string parses to a known unit
  const [unitOverride, setUnitOverride] = useState<ScheduleUnit | null>(null);
  const unit = unitOverride ?? parsed.unit;

  const updateUnit = (next: ScheduleUnit) => {
    if (next === "custom") {
      setUnitOverride("custom");
      return;
    }
    setUnitOverride(null);
    const newSchedule: ParsedSchedule = {
      ...parsed,
      unit: next,
      selectedDays:
        next === "week"
          ? parsed.selectedDays.length > 0
            ? parsed.selectedDays
            : [1, 2, 3, 4, 5]
          : next === "weekdays"
            ? [1, 2, 3, 4, 5]
            : [],
      dayOfMonth:
        next === "month" || next === "year" ? parsed.dayOfMonth || 1 : 1,
      month: next === "year" ? parsed.month || 1 : 1,
    };
    onChange(buildCron(newSchedule));
  };

  const updateTime = (time: string) => {
    const [hourText, minuteText] = time.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
    onChange(buildCron({ ...parsed, unit, hour, minute }));
  };

  const toggleDay = (day: number) => {
    const next = parsed.selectedDays.includes(day)
      ? parsed.selectedDays.filter((d) => d !== day)
      : [...parsed.selectedDays, day];
    if (next.length === 0) return;
    onChange(buildCron({ ...parsed, unit: "week", selectedDays: next }));
    setUnitOverride(null);
  };

  const updateDayOfMonth = (day: number) => {
    if (!Number.isInteger(day) || day < 1 || day > 31) return;
    onChange(buildCron({ ...parsed, unit, dayOfMonth: day }));
  };

  const updateMonth = (month: number) => {
    onChange(buildCron({ ...parsed, unit: "year", month }));
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* Repeat */}
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-muted-foreground w-16 shrink-0">
          Repeat
        </span>
        <Select
          value={unit}
          onValueChange={(v) => updateUnit(v as ScheduleUnit)}
          disabled={disabled}
        >
          <SelectTrigger className="w-[9rem] h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Every day</SelectItem>
            <SelectItem value="weekdays">Weekdays</SelectItem>
            <SelectItem value="week">Every week</SelectItem>
            <SelectItem value="month">Every month</SelectItem>
            <SelectItem value="year">Every year</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Day-of-week pills (week mode) */}
      {unit === "week" && (
        <div className="flex items-center gap-3 animate-in fade-in duration-150">
          <span className="text-[13px] text-muted-foreground w-16 shrink-0">
            on
          </span>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((day) => {
              const isSelected = parsed.selectedDays.includes(day.value);
              return (
                <button
                  key={day.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleDay(day.value)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[13px] font-medium transition-all duration-150",
                    isSelected
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {day.short}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Day-of-month (month + year) */}
      {(unit === "month" || unit === "year") && (
        <div className="flex items-center gap-3 animate-in fade-in duration-150">
          <span className="text-[13px] text-muted-foreground w-16 shrink-0">
            on day
          </span>
          <Input
            type="number"
            min={1}
            max={31}
            value={parsed.dayOfMonth}
            onChange={(e) => updateDayOfMonth(Number(e.target.value))}
            disabled={disabled}
            className="w-16 h-8 text-sm"
          />
        </div>
      )}

      {/* Month (year mode) */}
      {unit === "year" && (
        <div className="flex items-center gap-3 animate-in fade-in duration-150">
          <span className="text-[13px] text-muted-foreground w-16 shrink-0">
            in
          </span>
          <Select
            value={String(parsed.month)}
            onValueChange={(v) => updateMonth(Number(v))}
            disabled={disabled}
          >
            <SelectTrigger className="w-[9rem] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m) => (
                <SelectItem key={m.value} value={String(m.value)}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Time (non-custom) */}
      {unit !== "custom" && (
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-muted-foreground w-16 shrink-0">
            at
          </span>
          <Input
            type="time"
            value={formatTime(parsed.hour, parsed.minute)}
            onChange={(e) => updateTime(e.target.value)}
            disabled={disabled}
            className="w-[7rem] h-8 text-sm"
          />
        </div>
      )}

      {/* Custom cron input */}
      {unit === "custom" && (
        <div className="flex items-center gap-3 animate-in fade-in duration-150">
          <span className="text-[13px] text-muted-foreground w-16 shrink-0">
            cron
          </span>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="*/15 * * * *"
            className="font-mono text-sm h-8 flex-1"
          />
        </div>
      )}
    </div>
  );
}
