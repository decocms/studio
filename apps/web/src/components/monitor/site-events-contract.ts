/** Wire contract of the Logs tab, `GET /api/:org/monitor/:site/site/events?range&kinds&levels&services&q&cursor`: the site's own logs and spans, newest first. */

import { z } from "zod";

export const SITE_EVENT_RANGES = ["1h", "24h", "7d"] as const;
export type SiteEventRange = (typeof SITE_EVENT_RANGES)[number];

export const SITE_EVENT_LEVELS = [
  "error",
  "warn",
  "info",
  "ok",
  "debug",
] as const;
export type SiteEventLevel = (typeof SITE_EVENT_LEVELS)[number];

export const SITE_EVENT_KINDS = ["log", "span"] as const;
export type SiteEventKind = (typeof SITE_EVENT_KINDS)[number];

const count = z.number().int().nonnegative().catch(0);
const levelCounts = z.object({
  error: count,
  warn: count,
  info: count,
  ok: count,
  debug: count,
});

const SiteEvent = z.object({
  id: z.string(),
  /** ISO 8601. */
  timestamp: z.string(),
  kind: z.enum(SITE_EVENT_KINDS),
  level: z.enum(SITE_EVENT_LEVELS),
  service: z.string(),
  message: z.string(),
  /** A span's duration; null for a log. */
  durationMs: z.number().nullable().catch(null),
  traceId: z.string().nullable().catch(null),
  spanId: z.string().nullable().catch(null),
  /** OTel attribute values are scalars or arrays; the panel shows each as text. */
  attributes: z
    .record(z.string(), z.unknown())
    .transform((attributes) =>
      Object.fromEntries(
        Object.entries(attributes).flatMap(
          ([key, value]): [string, string][] =>
            value === null || value === undefined
              ? []
              : [
                  [
                    key,
                    typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value),
                  ],
                ],
        ),
      ),
    )
    .catch({}),
});
export type SiteEvent = z.infer<typeof SiteEvent>;

export const SiteEventsPage = z.object({
  /** Events matching every filter, across the whole range. */
  total: count,
  /** Equal buckets over the range, oldest first; counts ignore the level filter. */
  histogram: z.array(levelCounts.extend({ t: z.string() })).catch([]),
  /** Counts per level and per service under the other filters. */
  facets: z
    .object({
      levels: levelCounts,
      services: z.array(z.object({ name: z.string(), count })).catch([]),
    })
    .catch({
      levels: { error: 0, warn: 0, info: 0, ok: 0, debug: 0 },
      services: [],
    }),
  events: z.array(SiteEvent),
  /** Opaque; absent on the last page. */
  nextCursor: z.string().nullable().catch(null),
});
export type SiteEventsPage = z.infer<typeof SiteEventsPage>;
