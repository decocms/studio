/**
 * Synthetic answers of `/api/:org/monitor/:site/site/data` for the v8
 * Monitor's component tests, in the shapes `monitor-site.ts` returns (the
 * real SQL and transforms are checked against the warehouse; see the PR).
 */
import type {
  ErrorRow,
  ReleaseMarker,
  RouteRow,
  SiteSummary,
  SiteWindow,
  TimelinePoint,
  UpstreamRow,
} from "@/layouts/main-panel-tabs/monitor-v8";

const STEP_S = 15 * 60;

/** A 24h window ending at the bucket edge after `now`. */
export function fixtureWindow(now: number): SiteWindow {
  const stepMs = STEP_S * 1000;
  const endMs = Math.ceil((now + 1) / stepMs) * stepMs;
  return { startMs: endMs - 24 * 3_600_000, endMs, stepS: STEP_S };
}

/** A smooth daily curve, deterministic (no Math.random). */
function wave(i: number, n: number): number {
  const day = Math.sin((i / n) * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
  const ripple = Math.sin(i * 1.7) * 0.06 + Math.sin(i * 0.43) * 0.04;
  return 0.25 + day * 0.75 + ripple;
}

export function fixtureTimeline(w: SiteWindow): TimelinePoint[] {
  const n = (w.endMs - w.startMs) / (w.stepS * 1000);
  return Array.from({ length: n }, (_, i) => {
    const total = Math.round(900 * wave(i, n));
    const e5 =
      i >= 61 && i <= 64 ? Math.round(total * 0.06) : Math.round(total * 0.003);
    const e4 = Math.round(total * 0.03);
    const e3 = Math.round(total * 0.05);
    return {
      t: w.startMs + i * w.stepS * 1000,
      requests: total,
      "2xx": total - e5 - e4 - e3,
      "3xx": e3,
      "4xx": e4,
      "5xx": e5,
      p95Ms: Math.round(
        (i >= 61 && i <= 64 ? 620 : 300) + Math.sin(i * 0.9) * 25,
      ),
    };
  });
}

export const fixtureSummary: SiteSummary = {
  current: {
    requests: 48_210,
    errors5xx: 193,
    errorRate: 0.004,
    p50Ms: 84,
    p95Ms: 312,
    cacheHitRate: 0.71,
  },
  previous: {
    requests: 44_900,
    errors5xx: 120,
    errorRate: 0.0027,
    p50Ms: 90,
    p95Ms: 340,
    cacheHitRate: 0.66,
  },
  perSecond: 0.558,
};

export const fixtureRoutes: RouteRow[] = [
  { route: "/", requests: 18_020, p50Ms: 22, p95Ms: 60, errorRate: 0.0004 },
  {
    route: "/collections/:slug",
    requests: 12_004,
    p50Ms: 120,
    p95Ms: 290,
    errorRate: 0.002,
  },
  {
    route: "/products/:slug",
    requests: 9_105,
    p50Ms: 210,
    p95Ms: 540,
    errorRate: 0.011,
  },
  { route: "/s", requests: 3_410, p50Ms: 160, p95Ms: 410, errorRate: 0.003 },
  {
    route: "/_serverFn/*",
    requests: 2_870,
    p50Ms: 95,
    p95Ms: 240,
    errorRate: 0.001,
  },
  { route: "unmatched", requests: 1_101, p50Ms: 18, p95Ms: 45, errorRate: 0 },
];

export function fixtureReleases(w: SiteWindow): ReleaseMarker[] {
  return [
    {
      release:
        "4b59af4701ea5fd009ad8ed8d201ddd7895f9115d4fb023d3efcb0d5809c406e",
      firstSeenMs: w.startMs + 61 * w.stepS * 1000 + 120_000,
    },
    {
      release: "b15c8d52945d4570efbd49f9a48dd0e4e25e7c74",
      firstSeenMs: w.startMs + 65 * w.stepS * 1000 + 300_000,
    },
  ];
}

export const fixtureUpstreams: UpstreamRow[] = [
  {
    provider: "shopify",
    operation: "listing",
    calls: 14_020,
    p95Ms: 380,
    errorRate: 0.002,
    cachedRate: 0.63,
  },
  {
    provider: "shopify",
    operation: "product",
    calls: 9_204,
    p95Ms: 210,
    errorRate: 0.001,
    cachedRate: 0.58,
  },
  {
    provider: "shopify",
    operation: "cart",
    calls: 1_130,
    p95Ms: 290,
    errorRate: 0.009,
    cachedRate: 0,
  },
  {
    provider: "algolia",
    operation: "search",
    calls: 3_402,
    p95Ms: 95,
    errorRate: 0,
    cachedRate: 0.12,
  },
];

export function fixtureErrors(now: number): ErrorRow[] {
  return [
    {
      message: "shopify cart failed: Network connection lost.",
      route: "",
      code: "FETCH_FAILED",
      source: "shopify · cart",
      count: 12,
      lastSeenMs: now - 4 * 60_000,
    },
    {
      message:
        "block \"site/sections/ProductShelf.tsx\" failed: Cannot read properties of undefined (reading 'price')",
      route: "",
      code: "BLOCK_FAILED",
      source: "site/sections/ProductShelf.tsx",
      count: 5,
      lastSeenMs: now - 2 * 3_600_000,
    },
  ];
}
