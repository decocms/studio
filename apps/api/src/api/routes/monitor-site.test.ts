import { describe, expect, it } from "bun:test";
import {
  CLIENT_METRIC,
  emptyReason,
  metricsProbeQuery,
  quantile,
  querySiteView,
  resolveSiteWindow,
  SERVER_METRIC,
  SITE_VIEWS,
  siteViewQuery,
  toRoutes,
  toSummary,
  toTimeline,
  toUpstreams,
  type RunQuery,
  type SiteWindow,
} from "./monitor-site";

// The bounds @decocms/blocks sends (seconds), as stored in the warehouse.
const BOUNDS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];
/** Bucket counts with `counts[i]` in bucket i (15 buckets). */
const buckets = (at: Record<number, number>): number[] =>
  Array.from({ length: BOUNDS.length + 1 }, (_, i) => at[i] ?? 0);

const NOW = Date.parse("2026-10-19T12:34:56.789Z");

describe("resolveSiteWindow", () => {
  it("maps each range to its length and bucket size", () => {
    const h = resolveSiteWindow("1h", NOW) as SiteWindow;
    const d = resolveSiteWindow("24h", NOW) as SiteWindow;
    const w = resolveSiteWindow("7d", NOW) as SiteWindow;
    expect([h.stepS, d.stepS, w.stepS]).toEqual([60, 900, 7200]);
    expect(h.endMs - h.startMs).toBe(3_600_000);
    expect(d.endMs - d.startMs).toBe(86_400_000);
    expect(w.endMs - w.startMs).toBe(7 * 86_400_000);
  });

  it("ends at the next bucket edge after now, with a previous window of equal length", () => {
    const h = resolveSiteWindow("1h", NOW) as SiteWindow;
    expect(new Date(h.endMs).toISOString()).toBe("2026-10-19T12:35:00.000Z");
    expect(new Date(h.startMs).toISOString()).toBe("2026-10-19T11:35:00.000Z");
    expect(h.startMs - h.prevStartMs).toBe(3_600_000);
    const d = resolveSiteWindow("24h", NOW) as SiteWindow;
    expect(new Date(d.endMs).toISOString()).toBe("2026-10-19T12:45:00.000Z");
    const w = resolveSiteWindow("7d", NOW) as SiteWindow;
    expect(new Date(w.endMs).toISOString()).toBe("2026-10-19T14:00:00.000Z");
    // Exactly on an edge, the current bucket is the one starting now.
    const edge = resolveSiteWindow("1h", Date.parse("2026-10-19T12:00:00Z"));
    expect(new Date(edge?.endMs ?? 0).toISOString()).toBe(
      "2026-10-19T12:01:00.000Z",
    );
  });

  it("rejects any other range, including the CDN presets and prototype keys", () => {
    for (const r of ["7days", "30d", "today", "", "__proto__", "toString"]) {
      expect(resolveSiteWindow(r, NOW)).toBeNull();
    }
  });
});

describe("quantile", () => {
  it("interpolates inside the bucket that holds the rank", () => {
    // The 24h demo histogram: 130 calls in (0.1, 0.25], 36 in (0.25, 0.5],
    // 12 in (0.5, 0.75]. p50 = 0.1 + 0.15 × 89/130, p95 = 0.5 + 0.25 × 3.1/12.
    const h = { bounds: BOUNDS, buckets: buckets({ 6: 130, 7: 36, 8: 12 }) };
    expect(quantile([h], 0.5)).toBeCloseTo(0.1 + 0.15 * (89 / 130), 9);
    expect(quantile([h], 0.95)).toBeCloseTo(0.5 + 0.25 * (3.1 / 12), 9);
  });

  it("adds histograms bucket by bucket", () => {
    const a = { bounds: BOUNDS, buckets: buckets({ 6: 100 }) };
    const b = { bounds: BOUNDS, buckets: buckets({ 6: 30, 7: 36, 8: 12 }) };
    const merged = {
      bounds: BOUNDS,
      buckets: buckets({ 6: 130, 7: 36, 8: 12 }),
    };
    expect(quantile([a, b], 0.95)).toBeCloseTo(
      quantile([merged], 0.95) as number,
      9,
    );
  });

  it("starts the first bucket at zero", () => {
    const h = { bounds: BOUNDS, buckets: buckets({ 0: 10 }) };
    expect(quantile([h], 0.5)).toBeCloseTo(0.0025, 9);
  });

  it("closes the open-ended last bucket at the largest observation", () => {
    const h = { bounds: BOUNDS, buckets: buckets({ 14: 4 }), max: 30 };
    expect(quantile([h], 0.5)).toBeCloseTo(20, 9);
    // Without a usable max, the last bucket is a point at the last bound.
    expect(quantile([{ ...h, max: 0 }], 0.5)).toBe(10);
    expect(quantile([{ ...h, max: Number.NaN }], 0.99)).toBe(10);
  });

  it("merges histograms whose bounds differ", () => {
    // 10 in (0, 1] and 10 in (0, 2]: half of the second lies in (0, 1], so
    // 15 of 20 are ≤ 1 and the median is at 2/3.
    const a = { bounds: [1], buckets: [10, 0] };
    const b = { bounds: [2], buckets: [10, 0] };
    expect(quantile([a, b], 0.5)).toBeCloseTo(2 / 3, 9);
    expect(quantile([a, b], 1)).toBeCloseTo(2, 9);
  });

  it("is null with nothing to rank, and skips malformed histograms", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(
      quantile([{ bounds: BOUNDS, buckets: buckets({}) }], 0.5),
    ).toBeNull();
    expect(quantile([{ bounds: [1, 2], buckets: [5] }], 0.5)).toBeNull();
  });

  it("clamps q to [0, 1]", () => {
    const h = { bounds: BOUNDS, buckets: buckets({ 6: 10 }) };
    expect(quantile([h], -1)).toBeCloseTo(0.1, 9);
    expect(quantile([h], 2)).toBeCloseTo(0.25, 9);
  });
});

describe("tenancy", () => {
  const w = resolveSiteWindow("24h", NOW) as SiteWindow;
  const hostile = "acme' OR 1=1 --";

  it("scopes every view to the site's collector stamp, in production, bound as a parameter", () => {
    for (const view of SITE_VIEWS) {
      const { query, params } = siteViewQuery(view, hostile, w);
      expect(query).toContain("ServiceName = {slug:String}");
      expect(query).toContain(
        "ResourceAttributes['deco.site'] = {slug:String}",
      );
      expect(query).toContain(
        "ResourceAttributes['deployment.environment.name'] IN ('production', '')",
      );
      expect(query).not.toContain(hostile);
      expect(params.slug).toBe(hostile);
      expect(params.end).toBe(w.endMs);
    }
    const probe = metricsProbeQuery(hostile, NOW);
    expect(probe.query).toContain(
      "ResourceAttributes['deco.site'] = {slug:String}",
    );
    expect(probe.query).not.toContain(hostile);
  });

  it("reads the request metric for the site views and the client metric for upstreams", () => {
    expect(siteViewQuery("summary", "s", w).params.metric).toBe(SERVER_METRIC);
    expect(siteViewQuery("timeline", "s", w).params.metric).toBe(SERVER_METRIC);
    expect(siteViewQuery("routes", "s", w).params.metric).toBe(SERVER_METRIC);
    expect(siteViewQuery("upstreams", "s", w).params.metric).toBe(
      CLIENT_METRIC,
    );
  });

  it("rejects an unknown view", () => {
    expect(() => siteViewQuery("top-paths", "s", w)).toThrow();
  });
});

describe("transforms", () => {
  const w = resolveSiteWindow("1h", NOW) as SiteWindow;

  it("summarizes the current and previous windows (64-bit counts arrive quoted)", () => {
    const s = toSummary(
      [
        {
          current: 1,
          bounds: BOUNDS,
          buckets: buckets({ 5: 80, 6: 20 }).map(String),
          count: "100",
          max: 0.2,
          errors: "4",
          hits: "70",
          // Drafts, server functions and POSTs never reach the cache.
          cacheable: "80",
        },
        {
          current: 0,
          bounds: BOUNDS,
          buckets: buckets({ 6: 50 }).map(String),
          count: "50",
          max: 0.2,
          errors: "0",
          hits: "10",
          cacheable: "40",
        },
      ],
      w,
    );
    expect(s.current).toEqual({
      requests: 100,
      errors5xx: 4,
      errorRate: 0.04,
      p50Ms: Math.round((0.075 + 0.025 * (50 / 80)) * 1000),
      // 0.1 + 0.15 × 15/20 = 0.2125 s.
      p95Ms: 212,
      // HIT over HIT + MISS: 70 / 80.
      cacheHitRate: 0.875,
    });
    expect(s.previous.requests).toBe(50);
    expect(s.previous.cacheHitRate).toBe(0.25);
    expect(s.perSecond).toBeCloseTo(100 / 3600, 9);
  });

  it("has null rates and percentiles for a window with no requests", () => {
    const s = toSummary([], w);
    expect(s.current).toEqual({
      requests: 0,
      errors5xx: 0,
      errorRate: null,
      p50Ms: null,
      p95Ms: null,
      cacheHitRate: null,
    });
  });

  it("returns one timeline point per bucket, split by status", () => {
    const t0 = w.startMs / 1000;
    const row = (t: number, status_class: string, count: number) => ({
      t: String(t),
      status_class,
      bounds: BOUNDS,
      buckets: buckets({ 6: count }),
      count: String(count),
      max: 0.2,
    });
    const points = toTimeline(
      [
        row(t0, "2xx", 8),
        row(t0, "5xx", 2),
        row(t0, "1xx", 1),
        row(t0 + 120, "3xx", 3),
      ],
      w,
    );
    expect(points).toHaveLength(60);
    expect(points[0]).toMatchObject({
      t: w.startMs,
      requests: 11,
      "2xx": 9,
      "5xx": 2,
    });
    // 0.1 + 0.15 × 0.95 = 0.2425 s, rounded to whole ms.
    expect(Math.abs((points[0]?.p95Ms ?? 0) - 242.5)).toBeLessThanOrEqual(0.5);
    expect(points[1]).toMatchObject({ requests: 0, p95Ms: null });
    expect(points[2]).toMatchObject({ requests: 3, "3xx": 3 });
    expect(points.at(-1)?.t).toBe(w.endMs - 60_000);
  });

  it("ranks routes by requests, merging their histograms, top 20", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => ({
        route: `/r${i}`,
        bounds: BOUNDS,
        buckets: buckets({ 6: i + 1 }),
        count: i + 1,
        max: 0.2,
        errors: 0,
      })),
      // `/r0` again with other bounds (a second bounds group).
      {
        route: "/r0",
        bounds: [1],
        buckets: [100, 0],
        count: 100,
        max: 0.9,
        errors: 10,
      },
      {
        route: "",
        bounds: BOUNDS,
        buckets: buckets({ 6: 1 }),
        count: 1,
        max: 0.2,
        errors: 1,
      },
    ];
    const routes = toRoutes(rows);
    expect(routes).toHaveLength(20);
    expect(routes[0]).toMatchObject({ route: "/r0", requests: 101 });
    expect(routes[0]?.errorRate).toBeCloseTo(10 / 101, 9);
    expect(routes[1]?.route).toBe("/r24");
    const all = toRoutes(rows.slice(-2));
    expect(all.map((r) => r.route)).toEqual(["/r0", "unmatched"]);
  });

  it("groups upstreams by provider and operation", () => {
    const up = toUpstreams([
      {
        provider: "shopify",
        operation: "product",
        bounds: BOUNDS,
        buckets: buckets({ 7: 10 }),
        count: "10",
        max: 0.4,
        errors: "1",
        cached: "6",
      },
      {
        provider: "shopify",
        operation: "cart",
        bounds: BOUNDS,
        buckets: buckets({ 7: 20 }),
        count: "20",
        max: 0.4,
        errors: "0",
        cached: "0",
      },
      {
        provider: "shopify",
        operation: "product",
        bounds: [1],
        buckets: ["10", "0"],
        count: "10",
        max: 0.4,
        errors: "0",
        cached: "4",
      },
    ]);
    expect(
      up.map((u) => [u.operation, u.calls, u.errorRate, u.cachedRate]),
    ).toEqual([
      ["product", 20, 0.05, 0.5],
      ["cart", 20, 0, 0],
    ]);
  });
});

describe("empty request views", () => {
  const w = resolveSiteWindow("24h", NOW) as SiteWindow;
  /** A warehouse answering the probe with `metrics` and every view with `rows`. */
  const warehouse =
    (metrics: string[], rows: unknown[] = []): RunQuery =>
    async <T>(query: string) =>
      (query.includes("SELECT DISTINCT MetricName")
        ? metrics.map((metric) => ({ metric }))
        : rows) as T[];

  it("explains why: no telemetry, a Blocks version before the request metric, or a quiet range", () => {
    expect(emptyReason([])).toBe("no_telemetry");
    expect(emptyReason([CLIENT_METRIC])).toBe("server_metric_missing");
    expect(emptyReason([CLIENT_METRIC, SERVER_METRIC])).toBe("no_requests");
  });

  it("answers each request view with a reason and no data before 8.5", async () => {
    for (const view of ["summary", "timeline", "routes"]) {
      expect(
        await querySiteView(warehouse([CLIENT_METRIC]), view, "s", w, NOW),
      ).toEqual({ data: null, reason: "server_metric_missing" });
    }
  });

  it("keeps upstreams, errors and releases working without the request metric", async () => {
    for (const view of ["upstreams", "errors", "releases"]) {
      expect(
        await querySiteView(warehouse([CLIENT_METRIC]), view, "s", w, NOW),
      ).toEqual({ data: [] });
    }
  });

  it("answers data, without a reason, once requests arrive", async () => {
    const answer = await querySiteView(
      warehouse(
        [CLIENT_METRIC, SERVER_METRIC],
        [
          {
            route: "/",
            bounds: BOUNDS,
            buckets: buckets({ 6: 3 }),
            count: "3",
            max: 0.2,
            errors: "0",
          },
        ],
      ),
      "routes",
      "s",
      w,
      NOW,
    );
    expect(answer.reason).toBeUndefined();
    expect(answer.data).toEqual([
      { route: "/", requests: 3, p50Ms: 175, p95Ms: 242, errorRate: 0 },
    ]);
  });
});
