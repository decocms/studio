/**
 * The reports engine's public one-pager
 * (`GET /api/v2/public/diagnostics/:domain/onepager`) and the proxy types the
 * /report page reads through `/api/_reports/*`. The engine owns the buckets and
 * their order (decocms/reports `api/diagnostic/onepager.ts`); this schema only
 * checks the fields the page renders.
 */

import { z } from "zod";

const OnePagerItemSchema = z.object({
  check_id: z.string(),
  /** Registry title: states the DESIRED state, which this site does not meet. */
  title: z.string(),
  description: z.string().optional(),
  /** Per-run sentence grounded in this store's evidence; wins over `why`. */
  impact: z.string().optional(),
  why: z.string().optional(),
  category: z.string(),
  severity: z.string(),
  value_band: z.string().optional(),
  value_driver: z.string().optional(),
  controllability: z.string().optional(),
  pages: z.array(z.string()),
  tasks: z.array(z.string()),
  evidence: z.string(),
  sample_scope: z.string().optional(),
  sources: z.array(z.string()),
});

export const OnePagerSchema = z.object({
  domain: z.string(),
  brand: z.string(),
  favicon: z.string().optional(),
  scanned_at: z.string().nullable(),
  lang: z.string(),
  score: z.number().nullable(),
  band: z.string().nullable(),
  totals: z.object({
    measured: z.number(),
    registry_total: z.number(),
    passed: z.number(),
    failed: z.number(),
    blocked: z.number(),
  }),
  buckets: z.array(
    z.object({
      id: z.enum(["critical", "important", "worth"]),
      label: z.string(),
      items: z.array(OnePagerItemSchema),
    }),
  ),
  passing: z.object({
    count: z.number(),
    items: z.array(z.object({ check_id: z.string(), title: z.string() })),
  }),
  not_measured: z.object({
    count: z.number(),
    groups: z.array(
      z.object({
        reason: z.string(),
        label: z.string(),
        count: z.number(),
        checks: z.array(z.string()),
      }),
    ),
  }),
  categories: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      score: z.number().nullable(),
      band: z.string().nullable(),
      pass: z.number(),
      fail: z.number(),
    }),
  ),
  screenshots: z.array(
    z.object({
      url: z.string(),
      page_type: z.string().optional(),
      viewport: z.enum(["desktop", "mobile"]),
      image_url: z.string(),
    }),
  ),
});

export type OnePager = z.infer<typeof OnePagerSchema>;
export type OnePagerItem = OnePager["buckets"][number]["items"][number];
export type OnePagerBucketId = OnePager["buckets"][number]["id"];

/** What the report page receives from `GET /api/_reports/site/:domain`.
 *  `empty` means the engine knows the domain but no scan has finished yet. */
export type ReportState =
  | { status: "ready"; report: OnePager }
  | { status: "empty" | "not_found"; report: null };

/** Run response from POST /api/v2/diagnostics/run (idempotent + single-flight). */
export interface ScanTrigger {
  /** fresh = recent run reused · running = a durable run (poll `id`) · sync = ran inline · blocked = locked down. */
  state: "fresh" | "running" | "sync" | "blocked";
  id?: string | null;
}

export interface ScanStatus {
  /** running while queued/running/paused; done once terminal. */
  done: boolean;
  status: string;
}

/** What an email link's `d` token resolves to. */
export interface ResolvedLinkToken {
  domain: string;
  run_id: string;
  issued_at: string;
}

export interface DomainSuggestion {
  domain: string;
  /** a published report exists — selecting it lands on an instant result. */
  hasReport: boolean;
}
