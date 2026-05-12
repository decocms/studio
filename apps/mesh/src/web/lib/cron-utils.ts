/**
 * Cron expression utilities for automation triggers.
 */

export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,-]+$/.test(p));
}

export function humanReadableCron(expr: string): string {
  if (!expr) return "Unknown schedule";
  const e = expr.trim();

  // Exact matches
  if (e === "* * * * *") return "Every minute";
  if (e === "0 * * * *") return "Every hour";
  if (e === "0 0 * * *") return "Every day";
  if (e === "0 0 * * 1") return "Every week";

  // Every N minutes: */N * * * *
  const everyNMin = e.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyNMin) return `Every ${everyNMin[1]} minutes`;

  // Every N hours: 0 */N * * *
  const everyNHr = e.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyNHr) return `Every ${everyNHr[1]} hours`;

  // Every N days (or N*7 days = weeks): 0 0 */N * *
  const everyNDay = e.match(/^0\s+0\s+\*\/(\d+)\s+\*\s+\*$/);
  if (everyNDay) {
    const n = parseInt(everyNDay[1] ?? "1");
    if (n % 7 === 0) return `Every ${n / 7} weeks`;
    return `Every ${n} days`;
  }

  // Daily at specific time: M H * * *
  const dailyMatch = e.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (dailyMatch) {
    const h = (dailyMatch[2] ?? "0").padStart(2, "0");
    const m = (dailyMatch[1] ?? "0").padStart(2, "0");
    return `Every day at ${h}:${m} UTC`;
  }

  // Weekly at specific time: M H * * DOW
  const weeklyMatch = e.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+(\d)$/);
  if (weeklyMatch) {
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dayName = days[parseInt(weeklyMatch[3] ?? "0")] ?? "day";
    const h = (weeklyMatch[2] ?? "0").padStart(2, "0");
    const m = (weeklyMatch[1] ?? "0").padStart(2, "0");
    return `Every ${dayName} at ${h}:${m} UTC`;
  }

  return expr;
}

export type TimeUnit = "minutes" | "hours" | "days" | "weeks";

export function buildCronFromInterval(count: number, unit: TimeUnit): string {
  const n = Math.max(1, count);
  switch (unit) {
    case "minutes":
      return n === 1 ? "* * * * *" : `*/${n} * * * *`;
    case "hours":
      return n === 1 ? "0 * * * *" : `0 */${n} * * *`;
    case "days":
      return n === 1 ? "0 0 * * *" : `0 0 */${n} * *`;
    case "weeks":
      return n === 1 ? "0 0 * * 1" : `0 0 */${n * 7} * *`;
  }
}

export function parseCronToInterval(
  expr: string,
): { count: number; unit: TimeUnit } | null {
  const e = expr.trim();
  if (e === "* * * * *") return { count: 1, unit: "minutes" };
  if (e === "0 * * * *") return { count: 1, unit: "hours" };
  if (e === "0 0 * * *") return { count: 1, unit: "days" };
  if (e === "0 0 * * 1") return { count: 1, unit: "weeks" };
  const m = e.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (m) return { count: parseInt(m[1]!), unit: "minutes" };
  const h = e.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (h) return { count: parseInt(h[1]!), unit: "hours" };
  const d = e.match(/^0\s+0\s+\*\/(\d+)\s+\*\s+\*$/);
  if (d) {
    const n = parseInt(d[1]!);
    if (n % 7 === 0) return { count: n / 7, unit: "weeks" };
    return { count: n, unit: "days" };
  }
  return null;
}

export function unitLabel(unit: TimeUnit, count: number): string {
  const singular: Record<TimeUnit, string> = {
    minutes: "minute",
    hours: "hour",
    days: "day",
    weeks: "week",
  };
  return count === 1 ? (singular[unit] ?? unit) : unit;
}

export const SCHEDULE_UNITS = [
  { label: "5 minutes", cron: "*/5 * * * *" },
  { label: "Hour", cron: "0 * * * *" },
  { label: "Day", cron: "0 0 * * *" },
  { label: "Week", cron: "0 0 * * 1" },
] as const;
