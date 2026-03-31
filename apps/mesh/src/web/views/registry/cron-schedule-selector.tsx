import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";

type CronFrequency = "daily" | "weekly" | "biweekly" | "monthly" | "custom";

interface CronScheduleSelectorProps {
  value: string;
  onChange: (cronExpression: string) => void;
  disabled?: boolean;
}

const WEEK_DAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function parseCronExpression(value: string): {
  frequency: CronFrequency;
  minute: number;
  hour: number;
  weekDay: number;
  dayOfMonth: number;
} {
  const normalized = value.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    return {
      frequency: "custom",
      minute: 0,
      hour: 9,
      weekDay: 1,
      dayOfMonth: 1,
    };
  }

  const [minutePart, hourPart, dayOfMonthPart, _monthPart, dayOfWeekPart] =
    parts;
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  const dayOfMonth = Number(dayOfMonthPart);
  const weekDay = Number(dayOfWeekPart);
  const validTime =
    Number.isInteger(minute) &&
    Number.isInteger(hour) &&
    minute >= 0 &&
    minute <= 59 &&
    hour >= 0 &&
    hour <= 23;

  if (!validTime) {
    return {
      frequency: "custom",
      minute: 0,
      hour: 9,
      weekDay: 1,
      dayOfMonth: 1,
    };
  }

  if (dayOfMonthPart === "*" && dayOfWeekPart === "*") {
    return {
      frequency: "daily",
      minute,
      hour,
      weekDay: 1,
      dayOfMonth: 1,
    };
  }

  if (dayOfMonthPart === "*/14" && dayOfWeekPart === "*") {
    return {
      frequency: "biweekly",
      minute,
      hour,
      weekDay: 1,
      dayOfMonth: 1,
    };
  }

  if (
    dayOfMonthPart === "*" &&
    Number.isInteger(weekDay) &&
    weekDay >= 0 &&
    weekDay <= 6
  ) {
    return {
      frequency: "weekly",
      minute,
      hour,
      weekDay,
      dayOfMonth: 1,
    };
  }

  if (
    dayOfWeekPart === "*" &&
    Number.isInteger(dayOfMonth) &&
    dayOfMonth >= 1 &&
    dayOfMonth <= 31
  ) {
    return {
      frequency: "monthly",
      minute,
      hour,
      weekDay: 1,
      dayOfMonth,
    };
  }

  return {
    frequency: "custom",
    minute,
    hour,
    weekDay: 1,
    dayOfMonth: 1,
  };
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildCron(args: {
  frequency: CronFrequency;
  hour: number;
  minute: number;
  weekDay: number;
  dayOfMonth: number;
  currentValue: string;
}): string {
  if (args.frequency === "daily") {
    return `${args.minute} ${args.hour} * * *`;
  }
  if (args.frequency === "weekly") {
    return `${args.minute} ${args.hour} * * ${args.weekDay}`;
  }
  if (args.frequency === "biweekly") {
    // Standard cron has no native "every other Tuesday", so we use every 14 days.
    return `${args.minute} ${args.hour} */14 * *`;
  }
  if (args.frequency === "monthly") {
    return `${args.minute} ${args.hour} ${args.dayOfMonth} * *`;
  }
  return args.currentValue;
}

export function CronScheduleSelector({
  value,
  onChange,
  disabled = false,
}: CronScheduleSelectorProps) {
  const parsed = parseCronExpression(value);
  const isCustom = parsed.frequency === "custom";

  const updateFrequency = (frequency: CronFrequency) => {
    if (frequency === "custom") {
      onChange(value);
      return;
    }
    onChange(
      buildCron({
        frequency,
        hour: parsed.hour,
        minute: parsed.minute,
        weekDay: parsed.weekDay,
        dayOfMonth: parsed.dayOfMonth,
        currentValue: value,
      }),
    );
  };

  const updateTime = (time: string) => {
    const [hourText, minuteText] = time.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
    onChange(
      buildCron({
        frequency: parsed.frequency,
        hour,
        minute,
        weekDay: parsed.weekDay,
        dayOfMonth: parsed.dayOfMonth,
        currentValue: value,
      }),
    );
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <label className="space-y-1">
          <Label>Frequency</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={parsed.frequency}
            onChange={(event) =>
              updateFrequency(event.target.value as CronFrequency)
            }
            disabled={disabled}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly</option>
            <option value="custom">Custom (raw cron)</option>
          </select>
        </label>

        <label className="space-y-1">
          <Label>Time</Label>
          <Input
            type="time"
            value={formatTime(parsed.hour, parsed.minute)}
            onChange={(event) => updateTime(event.target.value)}
            disabled={disabled || isCustom}
          />
        </label>

        {parsed.frequency === "weekly" ? (
          <label className="space-y-1">
            <Label>Day of week</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={parsed.weekDay}
              onChange={(event) =>
                onChange(
                  buildCron({
                    frequency: "weekly",
                    hour: parsed.hour,
                    minute: parsed.minute,
                    weekDay: Number(event.target.value),
                    dayOfMonth: parsed.dayOfMonth,
                    currentValue: value,
                  }),
                )
              }
              disabled={disabled}
            >
              {WEEK_DAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </label>
        ) : parsed.frequency === "monthly" ? (
          <label className="space-y-1">
            <Label>Day of month</Label>
            <Input
              type="number"
              min={1}
              max={31}
              value={parsed.dayOfMonth}
              onChange={(event) => {
                const nextDay = Number(event.target.value);
                if (!Number.isInteger(nextDay) || nextDay < 1 || nextDay > 31) {
                  return;
                }
                onChange(
                  buildCron({
                    frequency: "monthly",
                    hour: parsed.hour,
                    minute: parsed.minute,
                    weekDay: parsed.weekDay,
                    dayOfMonth: nextDay,
                    currentValue: value,
                  }),
                );
              }}
              disabled={disabled}
            />
          </label>
        ) : (
          <div className="space-y-1">
            <Label>Schedule notes</Label>
            <div className="h-9 rounded-md border border-input bg-muted/20 px-3 text-xs text-muted-foreground flex items-center">
              {parsed.frequency === "biweekly"
                ? "Biweekly uses an every-14-days cron approximation."
                : parsed.frequency === "custom"
                  ? "Edit raw cron directly below."
                  : "Runs in your server timezone."}
            </div>
          </div>
        )}
      </div>

      <label className="space-y-1 block">
        <Label>Raw cron expression</Label>
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder="*/15 * * * *"
        />
      </label>
    </div>
  );
}
