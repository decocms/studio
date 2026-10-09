/**
 * Time Expression Parser
 *
 * Parses Grafana-style time expressions like:
 * - "now" - current time
 * - "now-5m" - 5 minutes ago
 * - "now-3h" - 3 hours ago
 * - "now-2d" - 2 days ago
 * - "now-1w" - 1 week ago
 * - "now-1M" - 1 month ago
 */

export type TimeUnit = "m" | "h" | "d" | "w" | "M";

export interface ParsedExpression {
  isNow: boolean;
  offset: number;
  unit: TimeUnit | null;
}

export interface TimeExpressionResult {
  valid: boolean;
  date: Date | null;
  error?: string;
}

const TIME_EXPRESSION_REGEX = /^now(?:-(\d+)([mhdwM]))?$/;

const UNIT_LABELS: Record<TimeUnit, string> = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  M: "month",
};

/**
 * Parse a time expression string into its components
 */
export function parseExpression(expression: string): ParsedExpression | null {
  const trimmed = expression.trim();

  if (trimmed === "now") {
    return { isNow: true, offset: 0, unit: null };
  }

  const match = trimmed.match(TIME_EXPRESSION_REGEX);
  if (!match) return null;

  const offset = match[1] ? Number.parseInt(match[1], 10) : 0;
  const unit = (match[2] as TimeUnit) || null;

  return { isNow: true, offset, unit };
}

/**
 * Convert a parsed expression to a Date object
 */
export function expressionToDate(expression: string): TimeExpressionResult {
  const trimmed = expression.trim();

  // Try to parse as ISO date first
  const isoDate = new Date(trimmed);
  if (!Number.isNaN(isoDate.getTime()) && trimmed.includes("-")) {
    return { valid: true, date: isoDate };
  }

  const parsed = parseExpression(trimmed);
  if (!parsed) {
    return {
      valid: false,
      date: null,
      error: 'Invalid expression. Use "now" or "now-Xu" (e.g., now-2d, now-3h)',
    };
  }

  const now = new Date();
  const result = new Date(now);

  if (parsed.offset === 0 || !parsed.unit) {
    return { valid: true, date: result };
  }

  switch (parsed.unit) {
    case "m":
      result.setMinutes(result.getMinutes() - parsed.offset);
      break;
    case "h":
      result.setHours(result.getHours() - parsed.offset);
      break;
    case "d":
      result.setDate(result.getDate() - parsed.offset);
      break;
    case "w":
      result.setDate(result.getDate() - parsed.offset * 7);
      break;
    case "M":
      result.setMonth(result.getMonth() - parsed.offset);
      break;
  }

  return { valid: true, date: result };
}

/**
 * Format a Date as a time expression (best effort)
 */
export function dateToExpression(date: Date): string {
  return date.toISOString();
}

/**
 * Format a Date for display in local time
 */
export function formatDateTimeLocal(date: Date): string {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a Date for input value (YYYY-MM-DDTHH:MM format for datetime-local)
 */
export function formatForDateTimeInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Check if a string is a valid time expression
 */
export function isValidExpression(expression: string): boolean {
  return expressionToDate(expression).valid;
}

/**
 * Check if a string is a "now" style time expression (not an absolute date)
 */
export function isTimeExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return TIME_EXPRESSION_REGEX.test(trimmed);
}

/**
 * Get a human-readable label for a time expression
 */
export function getExpressionLabel(expression: string): string {
  const trimmed = expression.trim();

  if (trimmed === "now") {
    return "Now";
  }

  const parsed = parseExpression(trimmed);
  if (!parsed || !parsed.unit) {
    // Try to format as date
    const result = expressionToDate(trimmed);
    if (result.valid && result.date) {
      return formatDateTimeLocal(result.date);
    }
    return trimmed;
  }

  const unitLabel = UNIT_LABELS[parsed.unit];
  const plural = parsed.offset !== 1 ? "s" : "";
  return `${parsed.offset} ${unitLabel}${plural} ago`;
}

/**
 * Quick range presets
 */
export interface QuickRange {
  label: string;
  from: string;
  to: string;
  value: string;
}

export const QUICK_RANGES: QuickRange[] = [
  { label: "Last 5 minutes", from: "now-5m", to: "now", value: "5m" },
  { label: "Last 15 minutes", from: "now-15m", to: "now", value: "15m" },
  { label: "Last 30 minutes", from: "now-30m", to: "now", value: "30m" },
  { label: "Last 1 hour", from: "now-1h", to: "now", value: "1h" },
  { label: "Last 3 hours", from: "now-3h", to: "now", value: "3h" },
  { label: "Last 6 hours", from: "now-6h", to: "now", value: "6h" },
  { label: "Last 12 hours", from: "now-12h", to: "now", value: "12h" },
  { label: "Last 24 hours", from: "now-24h", to: "now", value: "24h" },
  { label: "Last 2 days", from: "now-2d", to: "now", value: "2d" },
  { label: "Last 7 days", from: "now-7d", to: "now", value: "7d" },
  { label: "Last 30 days", from: "now-30d", to: "now", value: "30d" },
];

/**
 * Find a quick range by its value
 */
export function findQuickRange(value: string): QuickRange | undefined {
  return QUICK_RANGES.find((r) => r.value === value);
}

/**
 * Get display text for a time range
 */
export function getTimeRangeDisplayText(
  from: string,
  to: string,
  quickRanges: QuickRange[] = QUICK_RANGES,
): string {
  // Check if it matches a quick range
  const quickRange = quickRanges.find((r) => r.from === from && r.to === to);
  if (quickRange) {
    return quickRange.label;
  }

  // Otherwise format both expressions nicely
  return `${getExpressionLabel(from)} to ${getExpressionLabel(to)}`;
}
