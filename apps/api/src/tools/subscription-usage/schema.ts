import { z } from "zod";

export const SubscriptionProviderSchema = z.enum(["codex", "claude"]);
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>;
export const SubscriptionUsageSchema = z.object({
  status: z.enum(["available", "unavailable", "disconnected"]),
  reason: z
    .enum([
      "authorization",
      "permission",
      "rate_limited",
      "provider_error",
      "invalid_response",
      "no_data",
    ])
    .nullable(),
  checkedAt: z.string().datetime().nullable(),
  retryAt: z.string().datetime().nullable(),
  limitReached: z.boolean().nullable(),
  windows: z
    .array(
      z.object({
        id: z.enum([
          "primary",
          "secondary",
          "code_review_primary",
          "code_review_secondary",
          "five_hour",
          "seven_day",
          "seven_day_sonnet",
          "seven_day_opus",
        ]),
        usedPercent: z.number().min(0).max(100),
        resetAt: z.string().datetime().nullable(),
        windowSeconds: z.number().int().positive().nullable(),
      }),
    )
    .max(8),
});
export type SubscriptionUsage = z.infer<typeof SubscriptionUsageSchema>;
type Window = SubscriptionUsage["windows"][number];

const percent = z.number().finite().min(0).max(100);
const codexWindow = z.object({
  used_percent: percent,
  reset_at: z.number().int().min(0).max(253402300799).nullish(),
  limit_window_seconds: z.number().int().positive().nullish(),
});
const codexLimit = z.object({
  limit_reached: z.boolean().optional(),
  allowed: z.boolean().optional(),
  primary_window: codexWindow.nullish(),
  secondary_window: codexWindow.nullish(),
});
const codexUsage = z.object({
  rate_limit: codexLimit.nullish(),
  code_review_rate_limit: codexLimit.nullish(),
});
const claudeWindow = z.object({
  utilization: percent,
  resets_at: z.string().datetime({ offset: true }).nullish(),
});
const claudeUsage = z.object({
  five_hour: claudeWindow.nullish(),
  seven_day: claudeWindow.nullish(),
  seven_day_sonnet: claudeWindow.nullish(),
  seven_day_opus: claudeWindow.nullish(),
});

/** Keep only quota counters. Provider payloads may also contain account identifiers. */
export function parseSubscriptionUsage(
  provider: SubscriptionProvider,
  raw: unknown,
  now: Date,
): SubscriptionUsage {
  const windows: Window[] = [];
  let limitReached: boolean | null = null;
  if (provider === "codex") {
    const data = codexUsage.parse(raw);
    const main = data.rate_limit;
    if (main?.limit_reached !== undefined || main?.allowed !== undefined) {
      limitReached = main.limit_reached === true || main.allowed === false;
    }
    for (const [prefix, limit] of [
      ["", main],
      ["code_review_", data.code_review_rate_limit],
    ] as const) {
      for (const slot of ["primary", "secondary"] as const) {
        const window = limit?.[`${slot}_window`];
        if (!window) continue;
        windows.push({
          id: `${prefix}${slot}`,
          usedPercent: window.used_percent,
          resetAt:
            window.reset_at == null
              ? null
              : new Date(window.reset_at * 1000).toISOString(),
          windowSeconds: window.limit_window_seconds ?? null,
        });
      }
    }
  } else {
    const data = claudeUsage.parse(raw);
    for (const id of [
      "five_hour",
      "seven_day",
      "seven_day_sonnet",
      "seven_day_opus",
    ] as const) {
      const window = data[id];
      if (window)
        windows.push({
          id,
          usedPercent: window.utilization,
          resetAt: window.resets_at
            ? new Date(window.resets_at).toISOString()
            : null,
          windowSeconds: id === "five_hour" ? 18000 : 604800,
        });
    }
  }
  if (windows.some((window) => window.usedPercent >= 100)) limitReached = true;
  return {
    status:
      windows.length || limitReached !== null ? "available" : "unavailable",
    reason: windows.length || limitReached !== null ? null : "no_data",
    checkedAt: now.toISOString(),
    retryAt: null,
    limitReached,
    windows,
  };
}
