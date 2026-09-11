/**
 * Local stand-in for the two upstreams the Hosting / E2E / Deco Analytics tabs
 * read through `apps/api/src/api/routes/hosting.ts`:
 *
 *   1. the Deco control-plane REST API  → http://localhost:8788/api/v1
 *   2. the Deco Analytics read surface  → http://localhost:8788/analytics
 *
 * It speaks the same wire contract the BFF expects (bearer auth, `{ items }` /
 * `{ vars, codeVars }` / `{ secrets }` envelopes, 202 on deploy + queue, and a
 * tenant-scoped `usageScope` on every analytics payload), and it is STATEFUL in
 * memory: env/secret/redirect/domain writes stick, a queued E2E run walks
 * pending → running → a finished run with artifacts, and analytics
 * register/config/disable/unregister flip the same status the tab re-reads. So
 * the write paths and their optimistic UI are exercised for real, not stubbed.
 *
 * Deliberately NOT covered: the Monitor tab (that reads ClickHouse directly —
 * see `scripts/dev-monitor-seed.ts`) and Monitor's OneDollarStats half, whose
 * API base is a hardcoded constant in the app: redirecting it would mean
 * editing `apps/api`, so its Audience view stays on the unconfigured state.
 *
 *   bun run scripts/dev-hosting-mock.ts [--port=8788] [--slug=demo-store]
 */

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v] as const;
    }),
);

const PORT = Number(args.get("port") ?? 8788);
const SLUG = args.get("slug") ?? "demo-store";
/** Must match the tokens in `.env` (CONTROLPLANE_SERVICE_TOKEN / ANALYTICS_MASTER_TOKEN). */
const CONTROLPLANE_TOKEN = args.get("cp-token") ?? "dev-controlplane-token";
const ANALYTICS_TOKEN = args.get("analytics-token") ?? "dev-analytics-token";
/** The warehouse id the BFF reads back from `analytics/status` and then scopes on. */
const WAREHOUSE_SITE_ID = args.get("warehouse-site-id") ?? "s4242";

const now = () => new Date();
const iso = (d: Date) => d.toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rnd = lcg(48291);
const jitter = (base: number, spread = 0.3) =>
  Math.max(1, Math.round(base * (1 - spread + rnd() * spread * 2)));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

// --- state -------------------------------------------------------------------

interface EnvVar {
  name: string;
  value: string;
  scope: "runtime" | "build";
}
interface Secret {
  name: string;
  origin: "control-plane" | "worker";
  scope: "runtime" | "build";
  boundOnWorker: boolean;
  updatedAt: string;
}
interface Redirect {
  id: string;
  from: string;
  to: string;
  type: "permanent" | "temporary";
  source: string;
}
interface Domain {
  host: string;
  canonical?: boolean;
  status: "active" | "pending" | "action-required";
  detail?: string;
  dns?: { type: string; name: string; value: string }[];
}
interface E2eCheck {
  subject: string;
  url: string;
  command: string;
  schedule: string | null;
  phase: "pending" | "running" | "succeeded" | "failed";
  updatedAt: string;
}
interface E2eRun {
  runId: string;
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  summary: {
    url: string;
    command: string;
    exitCode: number;
    fileCount: number;
  };
}
interface AnalyticsConfig {
  id: string;
  enabled: boolean;
  sampling: number;
  tier: string;
  modules: string[];
  domains: string[];
  quota: number;
}

const COMMITS = [
  "9f4c1d7ab3e2f0c8d5a6b7c8d9e0f1a2b3c4d5e6",
  "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  "c0ffee1234567890abcdef1234567890abcdef12",
  "deadbeef00112233445566778899aabbccddeeff",
  "7788990011223344556677889900112233445566",
  "abcdef9876543210fedcba9876543210fedcba98",
];

interface SiteState {
  env: EnvVar[];
  codeVars: EnvVar[];
  secrets: Secret[];
  redirects: Redirect[];
  domains: Domain[];
  checks: E2eCheck[];
  runs: E2eRun[];
  analytics: { registered: boolean; config: AnalyticsConfig | null };
  deployHistory: Array<Record<string, unknown>>;
}

function seedSite(slug: string): SiteState {
  const host = `www.${slug}.com.br`;
  return {
    env: [
      { name: "DECO_ENV", value: "production", scope: "runtime" },
      { name: "COMMERCE_PLATFORM", value: "vtex", scope: "runtime" },
      { name: "VTEX_ACCOUNT", value: slug, scope: "runtime" },
      {
        name: "NEXT_PUBLIC_SITE_URL",
        value: `https://${host}`,
        scope: "runtime",
      },
      { name: "SENTRY_ENVIRONMENT", value: "production", scope: "runtime" },
      { name: "NODE_VERSION", value: "22", scope: "build" },
      { name: "BUILD_CACHE", value: "1", scope: "build" },
    ],
    codeVars: [
      { name: "DECO_SITE_NAME", value: slug, scope: "runtime" },
      { name: "PLAUSIBLE_DOMAIN", value: host, scope: "runtime" },
    ],
    secrets: [
      {
        name: "VTEX_APP_KEY",
        origin: "control-plane",
        scope: "runtime",
        boundOnWorker: true,
        updatedAt: iso(daysAgo(41)),
      },
      {
        name: "VTEX_APP_TOKEN",
        origin: "control-plane",
        scope: "runtime",
        boundOnWorker: true,
        updatedAt: iso(daysAgo(41)),
      },
      {
        name: "SENTRY_AUTH_TOKEN",
        origin: "control-plane",
        scope: "build",
        boundOnWorker: false,
        updatedAt: iso(daysAgo(12)),
      },
      {
        name: "OPENAI_API_KEY",
        origin: "worker",
        scope: "runtime",
        boundOnWorker: true,
        updatedAt: iso(daysAgo(3)),
      },
    ],
    redirects: [
      {
        id: "rdr_1",
        from: "/promo",
        to: "/colecao/verao",
        type: "temporary",
        source: "control-plane",
      },
      {
        id: "rdr_2",
        from: "/institucional/trocas",
        to: "/institucional/trocas-e-devolucoes",
        type: "permanent",
        source: "control-plane",
      },
      {
        id: "rdr_3",
        from: "/tenis",
        to: "/tenis-corrida",
        type: "permanent",
        source: "code",
      },
    ],
    domains: [
      {
        host,
        canonical: true,
        status: "active",
        dns: [{ type: "CNAME", name: "www", value: "sites.deco.cx" }],
      },
      {
        host: `${slug}.com.br`,
        status: "active",
        dns: [{ type: "ALIAS", name: "@", value: "sites.deco.cx" }],
      },
      {
        host: `loja.${slug}.com.br`,
        status: "pending",
        detail: "Waiting for DNS propagation (checked 4 min ago)",
        dns: [{ type: "CNAME", name: "loja", value: "sites.deco.cx" }],
      },
    ],
    checks: [
      {
        subject: "home",
        url: `https://${host}/`,
        command: "smoke",
        schedule: "0 * * * *",
        phase: "succeeded",
        updatedAt: iso(minutesAgo(18)),
      },
      {
        subject: "checkout funnel",
        url: `https://${host}/tenis-corrida/nimbus-26`,
        command: "funnel",
        schedule: "0 8 * * *",
        phase: "failed",
        updatedAt: iso(minutesAgo(126)),
      },
    ],
    runs: [],
    analytics: {
      registered: true,
      config: {
        id: WAREHOUSE_SITE_ID,
        enabled: true,
        sampling: 1,
        tier: "growth",
        modules: ["core", "commerce", "vitals", "errors"],
        domains: [host, `${slug}.com.br`],
        quota: 5_000_000,
      },
    },
    deployHistory: [],
  };
}

const sites = new Map<string, SiteState>();
function site(slug: string): SiteState {
  const key = slug.toLowerCase();
  let s = sites.get(key);
  if (!s) {
    s = seedSite(key);
    sites.set(key, s);
  }
  return s;
}

/** Seeded finished runs, newest first — one failing so the detail sheet has a
 *  real failure (step error, console errors, bad vitals) to render. */
function seedRuns(slug: string): E2eRun[] {
  const host = `www.${slug}.com.br`;
  const runs: E2eRun[] = [];
  for (let i = 0; i < 14; i++) {
    const started = minutesAgo(60 * (i + 1) + 7);
    const failed = i === 1 || i === 6 || i === 9;
    runs.push({
      runId: `run_${String(1042 - i).padStart(6, "0")}`,
      status: failed ? "fail" : "pass",
      startedAt: iso(started),
      finishedAt: iso(new Date(started.getTime() + jitter(42_000))),
      summary: {
        url: i % 3 === 0 ? `https://${host}/` : `https://${host}/tenis-corrida`,
        command: i % 3 === 0 ? "smoke" : "funnel",
        exitCode: failed ? 1 : 0,
        fileCount: failed ? 11 : 8,
      },
    });
  }
  return runs;
}

// --- E2E run detail ----------------------------------------------------------

function runDetail(slug: string, runId: string) {
  const s = site(slug);
  const run = s.runs.find((r) => r.runId === runId) ?? s.runs[0];
  const host = `www.${slug}.com.br`;
  const failed = run?.status === "fail";
  const base = `http://localhost:${PORT}/artifacts`;

  const steps = (viewport: string) => {
    const list = [
      { name: "Open home", action: `goto https://${host}/` },
      { name: "Accept cookie banner", action: "click [data-cookie-accept]" },
      { name: "Search for a product", action: 'fill [name="q"] with "tenis"' },
      { name: "Open first result", action: "click .product-card:first-child" },
      { name: "Add to cart", action: "click [data-add-to-cart]" },
      { name: "Open minicart", action: "click [data-minicart-toggle]" },
      { name: "Go to checkout", action: "click a[href='/checkout']" },
    ];
    const failAt = failed ? 5 : -1;
    return list.map((step, i) => ({
      step: i + 1,
      name: step.name,
      status:
        failAt === i ? "fail" : failAt >= 0 && i > failAt ? "skipped" : "pass",
      durationMs: jitter(i === 0 ? 2400 : 900),
      screenshotUrl: `${base}/step-${i + 1}-${viewport}.svg`,
      actionDescription: step.action,
      usedSelector: step.action.split(" ").slice(1).join(" "),
      critical: i >= 4,
      ...(failAt === i
        ? {
            errorDetail: {
              slug: "minicart-not-opened",
              expected: "minicart drawer visible within 5000ms",
              suggestion:
                "The drawer only mounts after /api/cart resolves — it returned 500 in this run.",
            },
          }
        : {}),
    }));
  };

  const viewportRun = (viewport: string) => ({
    viewport,
    durationMs: jitter(38_000),
    verdict: failed ? "fail" : "pass",
    funnelVerdict: failed ? "incomplete" : "complete",
    steps: steps(viewport),
    console: failed
      ? [
          {
            type: "error",
            text: "POST /api/cart 500 (Internal Server Error)",
            location: "app.js:1:9821",
          },
          {
            type: "warning",
            text: "Minicart hydration mismatch on cart drawer",
            location: "minicart.tsx:44:7",
          },
        ]
      : [
          {
            type: "warning",
            text: "Image with src /banner.png has no explicit dimensions",
            location: "banner.tsx:12:3",
          },
        ],
    network: [
      {
        url: `https://${host}/`,
        method: "GET",
        status: 200,
        resourceType: "document",
      },
      {
        url: `https://${host}/api/segment`,
        method: "POST",
        status: 204,
        resourceType: "fetch",
      },
      {
        url: `https://${host}/api/cart`,
        method: "POST",
        status: failed ? 500 : 200,
        resourceType: "fetch",
      },
    ],
    videoUrl: `${base}/run-${viewport}.webm`,
    traceUrl: `${base}/trace-${viewport}.zip`,
  });

  return {
    runId: run?.runId ?? runId,
    status: run?.status ?? "pass",
    checks: [
      {
        name: "Home renders",
        status: "pass",
        viewport: "desktop",
        durationMs: 2410,
      },
      {
        name: "Search works",
        status: "pass",
        viewport: "desktop",
        durationMs: 1980,
      },
      {
        name: "Add to cart",
        status: failed ? "fail" : "pass",
        viewport: "mobile",
        durationMs: 5010,
      },
      {
        name: "Checkout reachable",
        status: failed ? "skipped" : "pass",
        viewport: "mobile",
        durationMs: 1740,
      },
    ],
    artifacts: [
      { name: "report.json", url: `${base}/report.json` },
      { name: "trace-desktop.zip", url: `${base}/trace-desktop.zip` },
      { name: "run-mobile.webm", url: `${base}/run-mobile.webm` },
    ],
    report: {
      platform: "cloudflare",
      viewports: ["desktop", "mobile"],
      verdict: failed ? "fail" : "pass",
      totalDurationMs: jitter(76_000),
      runs: [viewportRun("desktop"), viewportRun("mobile")],
      pages: [
        {
          url: `https://${host}/`,
          viewport: "desktop",
          status: 200,
          vitals: { lcp: 2140, cls: 0.04, fcp: 1180, ttfb: 320, inp: 140 },
        },
        {
          url: `https://${host}/`,
          viewport: "mobile",
          status: 200,
          vitals: {
            lcp: failed ? 4820 : 2860,
            cls: failed ? 0.28 : 0.07,
            fcp: 1640,
            ttfb: 410,
            inp: failed ? 420 : 190,
          },
        },
        {
          url: `https://${host}/tenis-corrida`,
          viewport: "mobile",
          status: 200,
          vitals: { lcp: 3120, cls: 0.09, fcp: 1720, ttfb: 380, inp: 210 },
        },
      ],
    },
  };
}

// --- analytics read surface --------------------------------------------------

const RANGE_BUCKETS: Record<
  string,
  { count: number; step: number; unit: "m" | "h" | "d" }
> = {
  "5m": { count: 10, step: 30, unit: "m" },
  "15m": { count: 15, step: 60, unit: "m" },
  "30m": { count: 15, step: 120, unit: "m" },
  "1h": { count: 12, step: 300, unit: "m" },
  "24h": { count: 24, step: 3600, unit: "h" },
  "7d": { count: 7, step: 86400, unit: "d" },
  "30d": { count: 30, step: 86400, unit: "d" },
};

function buckets(range: string): string[] {
  const spec = RANGE_BUCKETS[range] ?? RANGE_BUCKETS["24h"]!;
  const out: string[] = [];
  for (let i = spec.count - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * spec.step * 1000);
    out.push(
      spec.unit === "d"
        ? d.toISOString().slice(0, 10)
        : d.toISOString().slice(11, 16),
    );
  }
  return out;
}

/** Scale so a 30d window reads bigger than a 5m one. */
function rangeScale(range: string): number {
  return (
    {
      "5m": 0.004,
      "15m": 0.01,
      "30m": 0.02,
      "1h": 0.04,
      "24h": 1,
      "7d": 6.4,
      "30d": 26,
    }[range] ?? 1
  );
}

const bars = (pairs: ReadonlyArray<[string, number]>, scale: number) =>
  pairs.map(([k, n]) => ({ k, n: jitter(n * scale) }));

function analyticsPayload(view: string, range: string) {
  const s = rangeScale(range);
  const ts = buckets(range);
  const host = `www.${SLUG}.com.br`;

  const series = ts.map((t, i) => {
    const w = 0.75 + (i / Math.max(1, ts.length - 1)) * 0.5;
    const visitors = jitter(1_180 * s * w * 0.4);
    return {
      t,
      visitors,
      pageviews: jitter(visitors * 2.7),
      sessions: jitter(visitors * 1.25),
      bounce_pct: jitter(43, 0.12),
      duration_s: jitter(168, 0.18),
    };
  });
  const totals = series.reduce(
    (a, r) => ({
      visitors: a.visitors + r.visitors,
      pageviews: a.pageviews + r.pageviews,
      sessions: a.sessions + r.sessions,
    }),
    { visitors: 0, pageviews: 0, sessions: 0 },
  );

  switch (view) {
    case "live":
      return {
        liveVisitors: [
          {
            visitors: jitter(212),
            pageviews: jitter(486),
            events: jitter(1_240),
            last_event: "add_to_cart",
          },
        ],
        liveByMinute: buckets("5m").map((t) => ({ t, visitors: jitter(190) })),
        liveFeed: Array.from({ length: 12 }, () => ({
          minute: new Date(Date.now() - jitter(240) * 1000)
            .toISOString()
            .slice(11, 19),
          page: pick([
            "/",
            "/tenis-corrida",
            "/tenis-corrida/nimbus-26",
            "/checkout",
            "/busca?q=tenis",
          ]),
          event: pick(["pageview", "add_to_cart", "search", "purchase"]),
          country: pick(["BR", "US", "PT", "AR"]),
          device: pick(["mobile", "desktop"]),
        })),
        livePages: bars(
          [
            ["/", 96],
            ["/tenis-corrida", 54],
            ["/tenis-corrida/nimbus-26", 38],
            ["/checkout", 21],
            ["/busca?q=tenis", 14],
          ],
          1,
        ),
      };
    case "overview":
      return {
        kpis: [
          {
            visitors: totals.visitors,
            pageviews: totals.pageviews,
            sessions: totals.sessions,
            bounce_pct: 43,
            duration_s: 171,
          },
        ],
        series,
        funnel: [
          {
            viewed: jitter(totals.pageviews),
            view_item: jitter(totals.pageviews * 0.42),
            add_to_cart: jitter(totals.pageviews * 0.11),
            begin_checkout: jitter(totals.pageviews * 0.052),
            purchase: jitter(totals.pageviews * 0.021),
          },
        ],
        sources: bars(
          [
            ["google / organic", 4_200],
            ["direct", 2_950],
            ["instagram / social", 1_480],
            ["meta-ads / cpc", 1_120],
            ["newsletter / email", 610],
            ["tiktok / social", 380],
          ],
          s,
        ),
        pages: bars(
          [
            ["/", 6_400],
            ["/tenis-corrida", 3_100],
            ["/tenis-corrida/nimbus-26", 2_050],
            ["/camisetas", 1_240],
            ["/checkout", 880],
            ["/busca?q=tenis", 610],
          ],
          s,
        ),
        devices: bars(
          [
            ["mobile", 7_800],
            ["desktop", 3_300],
            ["tablet", 420],
          ],
          s,
        ),
        countries: bars(
          [
            ["Brazil", 9_600],
            ["United States", 720],
            ["Portugal", 410],
            ["Argentina", 260],
            ["Chile", 140],
          ],
          s,
        ),
        channels: bars(
          [
            ["Organic Search", 4_200],
            ["Direct", 2_950],
            ["Paid Social", 1_500],
            ["Organic Social", 1_480],
            ["Email", 610],
          ],
          s,
        ),
      };
    case "behaviour":
      return {
        pages: bars(
          [
            ["/", 6_400],
            ["/tenis-corrida", 3_100],
            ["/tenis-corrida/nimbus-26", 2_050],
            ["/camisetas", 1_240],
            ["/checkout", 880],
          ],
          s,
        ),
        entryPages: bars(
          [
            ["/", 5_100],
            ["/colecao/verao", 1_320],
            ["/tenis-corrida", 940],
            ["/camisetas/dry-fit-preta", 420],
          ],
          s,
        ),
        exitPages: bars(
          [
            ["/", 2_400],
            ["/checkout", 1_180],
            ["/tenis-corrida", 860],
            ["/busca?q=tenis", 520],
          ],
          s,
        ),
        scrollDepth: bars(
          [
            ["25%", 8_900],
            ["50%", 6_100],
            ["75%", 3_400],
            ["100%", 1_450],
          ],
          s,
        ),
        searches: bars(
          [
            ["tenis", 940],
            ["camiseta preta", 410],
            ["nimbus", 280],
            ["frete gratis", 160],
          ],
          s,
        ),
        outbound: bars(
          [
            ["instagram.com/demostore", 240],
            ["wa.me/5511999999999", 180],
            ["blog.demostore.com.br", 95],
          ],
          s,
        ),
        downloads: bars(
          [
            ["/tabela-de-medidas.pdf", 120],
            ["/politica-de-trocas.pdf", 64],
          ],
          s,
        ),
      };
    case "events":
      return {
        events: bars(
          [
            ["pageview", 24_800],
            ["view_item", 9_400],
            ["add_to_cart", 2_600],
            ["begin_checkout", 1_180],
            ["purchase", 480],
            ["newsletter_signup", 210],
          ],
          s,
        ),
        propKeys: bars(
          [
            ["item_id", 12_400],
            ["collection", 6_200],
            ["variant", 3_100],
            ["coupon", 640],
          ],
          s,
        ),
        propValues: bars(
          [
            ["nimbus-26", 2_100],
            ["dry-fit-preta", 1_450],
            ["verao-2026", 980],
            ["FRETEGRATIS", 410],
          ],
          s,
        ),
      };
    case "errors":
      return {
        errors: bars(
          [
            ["TypeError: cart is undefined", 184],
            ["NetworkError: /api/cart 500", 96],
            ["Hydration mismatch: minicart", 62],
            ["ChunkLoadError: product-page", 28],
          ],
          s,
        ),
        errorsByPage: bars(
          [
            ["/checkout", 190],
            ["/tenis-corrida/nimbus-26", 88],
            ["/", 42],
          ],
          s,
        ),
      };
    case "experiments":
      return {
        variants: [
          { k: "pdp-buybox-control", n: jitter(5_400 * s) },
          { k: "pdp-buybox-sticky", n: jitter(5_360 * s) },
          { k: "home-hero-video", n: jitter(2_900 * s) },
        ],
        variantConversion: [
          {
            variant: "pdp-buybox-control",
            sessions: jitter(5_400 * s),
            purchases: jitter(112 * s),
            conv_pct: 2.1,
          },
          {
            variant: "pdp-buybox-sticky",
            sessions: jitter(5_360 * s),
            purchases: jitter(138 * s),
            conv_pct: 2.6,
          },
        ],
      };
    case "vitals":
      return {
        vitalsSummary: [
          {
            lcp_p75: 2_840,
            cls_p75: 0.08,
            inp_p75: 190,
            ttfb_p75: 410,
            fcp_p75: 1_620,
          },
        ],
        vitalsTrend: ts.map((t) => ({
          t,
          lcp_p75: jitter(2_800, 0.12),
          inp_p75: jitter(190, 0.16),
        })),
        vitalsByPage: [
          { page: "/", lcp_p75: 2_410, cls_p75: 0.04, inp_p75: 150 },
          {
            page: "/tenis-corrida",
            lcp_p75: 3_120,
            cls_p75: 0.09,
            inp_p75: 210,
          },
          {
            page: "/tenis-corrida/nimbus-26",
            lcp_p75: 3_460,
            cls_p75: 0.12,
            inp_p75: 260,
          },
          { page: "/checkout", lcp_p75: 2_180, cls_p75: 0.03, inp_p75: 120 },
        ],
      };
    case "quality":
      return {
        quality: [
          {
            events_accepted: jitter(240_000 * s),
            events_rejected: jitter(1_800 * s),
            sessions_built: jitter(58_000 * s),
            min_sampling: 1,
          },
        ],
        rejections: bars(
          [
            ["missing_session_id", 780],
            ["bot_user_agent", 640],
            ["schema_mismatch", 210],
            ["out_of_window", 96],
          ],
          s,
        ),
        qualityTrend: ts.map((t) => ({
          t,
          accepted: jitter((240_000 * s) / Math.max(1, ts.length)),
          rejected: jitter((1_800 * s) / Math.max(1, ts.length)),
        })),
      };
    case "usage":
      return {
        usage: [
          {
            events_accepted: jitter(1_240_000 * (s / 26)),
            events_rejected: jitter(9_400 * (s / 26)),
            bytes_ingested: jitter(412_000_000 * (s / 26)),
          },
        ],
        usageTrend: ts.map((t) => ({
          t,
          events_accepted: jitter(48_000 * (s / Math.max(1, ts.length)) * 26),
        })),
        usageSites: [{ k: host, n: jitter(1_240_000 * (s / 26)) }],
      };
    default:
      return {};
  }
}

// --- helpers -----------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function authorized(req: Request, token: string): boolean {
  return req.headers.get("authorization") === `Bearer ${token}`;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A placeholder browser screenshot — an SVG so it needs no image encoder and
 *  still renders in the detail sheet's `<img>`. */
function screenshotSvg(label: string): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#f6f6f5"/>
  <rect width="1280" height="64" fill="#ffffff"/>
  <rect x="32" y="24" width="120" height="16" rx="4" fill="#d4d4d4"/>
  <rect x="1040" y="20" width="208" height="24" rx="12" fill="#ededec"/>
  <rect x="32" y="96" width="1216" height="320" rx="12" fill="#e4e4e3"/>
  <rect x="32" y="448" width="384" height="240" rx="12" fill="#ededec"/>
  <rect x="448" y="448" width="384" height="240" rx="12" fill="#ededec"/>
  <rect x="864" y="448" width="384" height="240" rx="12" fill="#ededec"/>
  <text x="640" y="270" font-family="ui-sans-serif,system-ui" font-size="28" fill="#8a8a86" text-anchor="middle">${label}</text>
</svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
}

// --- server ------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/health") return json({ ok: true, sites: [...sites.keys()] });

    // --- artifacts (E2E screenshots / video / trace / report) ---------------
    if (path.startsWith("/artifacts/")) {
      const name = decodeURIComponent(path.slice("/artifacts/".length));
      if (name.endsWith(".svg"))
        return screenshotSvg(name.replace(/\.svg$/, ""));
      if (name === "report.json") return json({ note: "mock artifact" });
      return new Response(`mock artifact: ${name}`, {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    // --- analytics read surface --------------------------------------------
    if (path === "/analytics/data") {
      if (!authorized(req, ANALYTICS_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
      const view = url.searchParams.get("view") ?? "overview";
      const range = url.searchParams.get("range") ?? "24h";
      const siteId = url.searchParams.get("site") ?? WAREHOUSE_SITE_ID;
      return json({
        view,
        range,
        site: siteId,
        // The BFF refuses any payload that isn't proven tenant-scoped.
        usageScope: {
          site: siteId,
          reader: "stats_reader",
          tenantScoped: true,
        },
        ...analyticsPayload(view, range),
      });
    }

    // --- control-plane REST -------------------------------------------------
    const cp = path.match(/^\/api\/v1\/sites\/([^/]+)\/(.+)$/);
    if (!cp) return json({ error: "not_found", path }, 404);
    if (!authorized(req, CONTROLPLANE_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    const slug = decodeURIComponent(cp[1]!).toLowerCase();
    const sub = cp[2]!;
    const s = site(slug);
    if (s.runs.length === 0) s.runs = seedRuns(slug);

    // Hosting — deployments
    if (method === "GET" && sub === "deployments") {
      const host = `www.${slug}.com.br`;
      return json({
        items: COMMITS.map((sha, i) => {
          const started = daysAgo(i * 1.4 + 0.2);
          const failed = i === 3;
          return {
            id: `dpl_${1200 - i}`,
            env: i === 1 ? "preview" : "production",
            framework: "htmx",
            commitSha: sha,
            shortCommit: sha.slice(0, 7),
            phase: failed ? "failed" : i === 0 ? "ready" : "superseded",
            up: i === 0,
            production: i === 0,
            servingUrl:
              i === 0 ? `https://${host}` : `https://dpl-${1200 - i}.deco.site`,
            startedAt: iso(started),
            finishedAt: iso(new Date(started.getTime() + jitter(96_000))),
            durationMs: jitter(96_000),
            createdAt: iso(started),
            source: i > 4 ? "observed" : "managed",
            buildMessage: failed
              ? "build failed: type error in sections/ProductShelf.tsx"
              : `feat(pdp): sticky buybox (${sha.slice(0, 7)})`,
          };
        }),
      });
    }

    if (method === "GET" && sub === "deployments/history") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const seeded = COMMITS.flatMap((sha, i) => {
        const at = daysAgo(i * 1.4);
        const events = [
          {
            id: `evt_${900 - i * 2}`,
            env: "production",
            commitSha: sha,
            deploymentId: `dpl_${1200 - i}`,
            framework: "htmx",
            action: "deploy",
            type: "deploy",
            outcome: i === 3 ? "failure" : "success",
            actor: pick(["rafaelvalls", "github-actions[bot]", "maria.souza"]),
            createdAt: iso(at),
          },
        ];
        if (i === 3) {
          events.push({
            id: `evt_${900 - i * 2 - 1}`,
            env: "production",
            commitSha: COMMITS[4]!,
            deploymentId: `dpl_${1196}`,
            framework: "htmx",
            action: "rollback",
            type: "rollback",
            outcome: "success",
            actor: "rafaelvalls",
            createdAt: iso(new Date(at.getTime() + 9 * 60_000)),
          });
        }
        return events;
      });
      return json({ items: [...s.deployHistory, ...seeded].slice(0, limit) });
    }

    if (method === "GET" && sub === "deployments/logs") {
      const commit = url.searchParams.get("commit") ?? "";
      return json({
        configured: true,
        available: true,
        text: [
          `> deco build ${commit.slice(0, 7)}`,
          "  fresh 1.7.3 / deno 2.1.4",
          "  ✓ manifest generated (142 sections, 38 loaders)",
          "  ✓ tailwind compiled in 1.9s",
          "  ✓ bundled client in 6.4s",
          "  ✓ uploaded 214 assets (18.2 MB)",
          "  deploy ready in 41.8s",
        ].join("\n"),
        truncated: false,
        logs: [
          {
            name: "build.log",
            url: `http://localhost:${PORT}/artifacts/build.log`,
            sizeBytes: 18_244,
          },
        ],
      });
    }

    // Hosting — env
    if (sub === "env") {
      if (method === "GET") return json({ vars: s.env, codeVars: s.codeVars });
      if (method === "PUT") {
        const b = await body(req);
        const vars = Array.isArray(b.vars) ? (b.vars as EnvVar[]) : [];
        s.env = vars.map((v) => ({
          name: String(v.name),
          value: String(v.value ?? ""),
          scope: v.scope === "build" ? "build" : "runtime",
        }));
        return json({ vars: s.env, replaced: s.env.length });
      }
    }

    // Hosting — secrets
    if (sub === "secrets") {
      if (method === "GET") return json({ secrets: s.secrets });
      if (method === "PUT") {
        const b = await body(req);
        const name = String(b.name ?? "").trim();
        if (!name) return json({ error: "name is required" }, 400);
        const scope = b.scope === "build" ? "build" : "runtime";
        const existing = s.secrets.find(
          (x) => x.name === name && x.scope === scope,
        );
        if (existing) existing.updatedAt = iso(now());
        else {
          s.secrets.push({
            name,
            origin: "control-plane",
            scope,
            boundOnWorker: true,
            updatedAt: iso(now()),
          });
        }
        return json({ name, scope, saved: true });
      }
    }
    const secretDelete = sub.match(/^secrets\/(.+)$/);
    if (secretDelete && method === "DELETE") {
      const name = decodeURIComponent(secretDelete[1]!);
      const scope = url.searchParams.get("scope");
      const before = s.secrets.length;
      s.secrets = s.secrets.filter(
        (x) => !(x.name === name && (!scope || x.scope === scope)),
      );
      return json({ name, scope, deleted: before !== s.secrets.length });
    }

    // Hosting — redirects
    if (sub === "redirects") {
      if (method === "GET") return json({ items: s.redirects });
      if (method === "PUT") {
        const b = await body(req);
        const from = String(b.from ?? "").trim();
        if (!from) return json({ error: "from is required" }, 400);
        const entry: Redirect = {
          id: `rdr_${Math.floor(rnd() * 1e6)}`,
          from,
          to: String(b.to ?? "/"),
          type: b.type === "temporary" ? "temporary" : "permanent",
          source: "control-plane",
        };
        const i = s.redirects.findIndex((r) => r.from === from);
        if (i >= 0) s.redirects[i] = { ...entry, id: s.redirects[i]!.id };
        else s.redirects.push(entry);
        return json({ item: entry });
      }
    }
    const redirectDelete = sub.match(/^redirects\/(.+)$/);
    if (redirectDelete && method === "DELETE") {
      const from = decodeURIComponent(redirectDelete[1]!);
      const before = s.redirects.length;
      s.redirects = s.redirects.filter((r) => r.from !== from);
      return json({ from, deleted: before !== s.redirects.length });
    }

    // Hosting — domains
    if (sub === "domains") {
      if (method === "GET") {
        return json({
          items: s.domains,
          dnsTemplate: [
            { type: "CNAME", name: "<subdomain>", value: "sites.deco.cx" },
            { type: "ALIAS", name: "@", value: "sites.deco.cx" },
          ],
        });
      }
      if (method === "PUT") {
        const b = await body(req);
        const host = String(b.host ?? "")
          .trim()
          .toLowerCase();
        if (!host) return json({ error: "host is required" }, 400);
        if (!s.domains.some((d) => d.host === host)) {
          s.domains.push({
            host,
            status: "pending",
            detail: "Waiting for DNS propagation",
            dns: [
              {
                type: host.split(".").length > 2 ? "CNAME" : "ALIAS",
                name: host.split(".").length > 2 ? host.split(".")[0]! : "@",
                value: "sites.deco.cx",
              },
            ],
          });
        }
        return json({ host, attached: true });
      }
    }
    const domainDelete = sub.match(/^domains\/(.+)$/);
    if (domainDelete && method === "DELETE") {
      const host = decodeURIComponent(domainDelete[1]!).toLowerCase();
      const before = s.domains.length;
      s.domains = s.domains.filter((d) => d.host !== host);
      return json({ host, deleted: before !== s.domains.length });
    }

    // Hosting — deploy
    if (sub === "deploy" && method === "POST") {
      const commit = COMMITS[0]!;
      s.deployHistory.unshift({
        id: `evt_${Math.floor(rnd() * 1e6)}`,
        env: "production",
        commitSha: commit,
        deploymentId: `dpl_${1300 + s.deployHistory.length}`,
        framework: "htmx",
        action: "redeploy",
        type: "redeploy",
        outcome: "queued",
        actor: "studio",
        createdAt: iso(now()),
      });
      return json(
        { accepted: true, commitSha: commit, env: "production" },
        202,
      );
    }

    // E2E
    if (sub === "e2e/types" && method === "GET") {
      return json({
        items: [
          {
            id: "smoke",
            label: "Smoke",
            description:
              "Loads the page, checks it renders and has no console errors.",
          },
          {
            id: "funnel",
            label: "Purchase funnel",
            description:
              "Search → PDP → add to cart → checkout, on desktop and mobile.",
          },
          {
            id: "vitals",
            label: "Web vitals",
            description: "Measures LCP / CLS / INP on the given URL.",
          },
        ],
      });
    }
    if (sub === "e2e/checks") {
      if (method === "GET") return json({ items: s.checks });
      if (method === "DELETE") {
        s.checks = [];
        s.runs = [];
        return json({ deleted: true });
      }
    }
    if (sub === "e2e/runs") {
      if (method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json({
          items: s.runs.slice(offset, offset + limit),
          total: s.runs.length,
        });
      }
      if (method === "POST") {
        const b = await body(req);
        const command = String(b.command ?? "smoke");
        const target = String(b.url ?? `https://www.${slug}.com.br/`);
        const check: E2eCheck = {
          subject: command,
          url: target,
          command,
          schedule: (b.schedule as string) ?? null,
          phase: "pending",
          updatedAt: iso(now()),
        };
        s.checks = [check, ...s.checks.filter((c) => c.command !== command)];
        // Walk the lifecycle so the tab's in-flight states are real.
        setTimeout(() => {
          check.phase = "running";
          check.updatedAt = iso(now());
        }, 4_000);
        setTimeout(() => {
          check.phase = "succeeded";
          check.updatedAt = iso(now());
          const started = new Date(Date.now() - 22_000);
          s.runs.unshift({
            runId: `run_${String(1043 + s.runs.length).padStart(6, "0")}`,
            status: "pass",
            startedAt: iso(started),
            finishedAt: iso(now()),
            summary: { url: target, command, exitCode: 0, fileCount: 8 },
          });
        }, 16_000);
        return json({ accepted: true, command, url: target }, 202);
      }
    }
    const runMatch = sub.match(/^e2e\/runs\/(.+)$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      if (method === "GET") return json(runDetail(slug, runId));
      if (method === "DELETE") {
        const before = s.runs.length;
        s.runs = s.runs.filter((r) => r.runId !== runId);
        return json({ runId, deleted: before !== s.runs.length });
      }
    }

    // Deco Analytics lifecycle
    if (sub === "analytics/status" && method === "GET") {
      return json({
        configured: true,
        registered: s.analytics.registered,
        host: `www.${slug}.com.br`,
        config: s.analytics.registered ? s.analytics.config : null,
      });
    }
    if (sub === "analytics/usage" && method === "GET") {
      const granularity = url.searchParams.get("granularity") ?? "day";
      return json({
        granularity,
        items: buckets("30d").map((t) => ({
          t,
          events_accepted: jitter(48_000),
          events_rejected: jitter(380),
        })),
      });
    }
    if (sub === "analytics/register" && method === "POST") {
      const b = await body(req);
      s.analytics = {
        registered: true,
        config: {
          id: WAREHOUSE_SITE_ID,
          enabled: true,
          sampling: Number(b.sampling ?? 1),
          tier: String(b.tier ?? "growth"),
          modules: Array.isArray(b.modules)
            ? (b.modules as string[])
            : ["core", "commerce"],
          domains: [`www.${slug}.com.br`],
          quota: 5_000_000,
        },
      };
      return json({
        registered: true,
        host: `www.${slug}.com.br`,
        key: "dq_pub_9f2a7c41e0b34d5f",
        snippet: `<script defer src="https://analytics.deco.cx/dq.js" data-site="${WAREHOUSE_SITE_ID}"></script>`,
        notes: [
          "Collection starts within a minute of the first pageview.",
          "Custom events go through window.__dq('event', name, props).",
        ],
      });
    }
    if (sub === "analytics/rotate-key" && method === "POST") {
      return json({
        registered: true,
        key: `dq_pub_${Math.floor(rnd() * 1e16).toString(16)}`,
        snippet: `<script defer src="https://analytics.deco.cx/dq.js" data-site="${WAREHOUSE_SITE_ID}"></script>`,
      });
    }
    if (sub === "analytics/disable" && method === "PUT") {
      const b = await body(req);
      if (s.analytics.config) s.analytics.config.enabled = b.enabled !== false;
      return json({ enabled: s.analytics.config?.enabled ?? false });
    }
    if (sub === "analytics/config" && method === "PUT") {
      const b = await body(req);
      if (s.analytics.config) {
        const c = s.analytics.config;
        if (Array.isArray(b.modules)) c.modules = b.modules as string[];
        if (b.sampling != null) c.sampling = Number(b.sampling);
        if (b.tier != null) c.tier = String(b.tier);
        if (Array.isArray(b.domains)) c.domains = b.domains as string[];
        if (b.quota != null) c.quota = Number(b.quota);
      }
      return json({ config: s.analytics.config });
    }
    if (sub === "analytics" && method === "DELETE") {
      s.analytics = { registered: false, config: null };
      return json({ deleted: true });
    }

    return json({ error: "not_found", sub, method }, 404);
  },
});

console.log(
  `dev hosting mock listening on http://localhost:${server.port}\n` +
    `  control-plane : http://localhost:${server.port}/api/v1  (Bearer ${CONTROLPLANE_TOKEN})\n` +
    `  analytics     : http://localhost:${server.port}/analytics  (Bearer ${ANALYTICS_TOKEN})\n` +
    `  seeded site   : ${SLUG} → warehouse ${WAREHOUSE_SITE_ID}`,
);
