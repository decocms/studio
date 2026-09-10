/**
 * Seed a LOCAL ClickHouse with the stats-lake shapes the Monitor tab
 * (`apps/api/src/api/routes/monitor.ts`) reads, so the CDN + Audience halves
 * render against a real warehouse instead of a stub.
 *
 * The tables are named exactly as the route queries them (`default.dim_sites`,
 * `default.fact_usage_{daily,hourly}_view`, `default.fact_top_urls_daily_view`,
 * `default.fact_analytics_daily_view`,
 * `default.fact_shared_infra_usage_daily_view`), so every aggregation, filter,
 * group-by and date window executes for real — no SQL is faked.
 *
 * Start the warehouse first:
 *   docker run -d --name deco-monitor-clickhouse -p 8123:8123 \
 *     -e CLICKHOUSE_USER=admin_monitor -e CLICKHOUSE_PASSWORD=dev-monitor \
 *     clickhouse/clickhouse-server:24.8
 *
 * Then: bun run scripts/dev-monitor-seed.ts [--slug=demo-store] [--site-id=4242]
 *
 * Idempotent: it drops and recreates the tables it owns.
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

const CH_URL = args.get("url") ?? "http://localhost:8123";
const CH_USER = args.get("user") ?? "admin_monitor";
const CH_PASS = args.get("password") ?? "dev-monitor";
const SLUG = args.get("slug") ?? "demo-store";
const SITE_ID = Number(args.get("site-id") ?? 4242);
/** Calendar days of daily history (covers the 180d / 1y presets partially). */
const DAYS = Number(args.get("days") ?? 200);

const auth = `Basic ${Buffer.from(`${CH_USER}:${CH_PASS}`).toString("base64")}`;

async function ch(query: string, body?: string): Promise<string> {
  const url = new URL(CH_URL);
  url.searchParams.set("query", query);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth },
    body: body ?? "",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

async function insert(table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 20_000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ndjson = rows
      .slice(i, i + CHUNK)
      .map((r) => JSON.stringify(r))
      .join("\n");
    await ch(`INSERT INTO default.${table} FORMAT JSONEachRow`, ndjson);
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

/** Deterministic PRNG — the same seed always produces the same dashboard, so a
 *  screenshot diff means a code change, not new noise. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rnd = lcg(20260909);
const jitter = (base: number, spread = 0.35) =>
  Math.max(1, Math.round(base * (1 - spread + rnd() * spread * 2)));

const HOSTS = [
  `${SLUG}.deco.site`,
  `www.${SLUG}.com.br`,
  `${SLUG}.com.br`,
] as const;
const CACHE = ["hit", "miss", "expired", "stale", "dynamic"] as const;
const STATUS = [200, 200, 200, 301, 304, 404, 500] as const;
const COUNTRIES = ["BR", "US", "PT", "AR", "CL", "MX", "ES", "CO"] as const;
const PATHS = [
  "/",
  "/busca?q=tenis",
  "/tenis-corrida",
  "/tenis-corrida/nimbus-26",
  "/camisetas",
  "/camisetas/dry-fit-preta",
  "/checkout",
  "/checkout/success",
  "/institucional/trocas-e-devolucoes",
  "/colecao/verao",
  "/api/segment",
  "/sitemap.xml",
  "/favicon.ico",
  "/live/carrinho",
  "/minha-conta/pedidos",
] as const;
const UTM_SOURCES = [
  "google",
  "instagram",
  "meta-ads",
  "newsletter",
  "direct",
  "tiktok",
] as const;
const DEVICES = ["mobile", "desktop", "tablet"] as const;
const EVENT_TYPES = ["PageView", "AddToCart", "Purchase", "Search"] as const;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dayOffset(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** A weekday/weekend + slow-growth traffic curve, so charts don't look flat. */
function trafficWeight(daysAgo: number, date: Date): number {
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const growth = 1 + (DAYS - daysAgo) / (DAYS * 2.2);
  return (weekend ? 0.72 : 1) * growth;
}
/** Hour-of-day shape (retail: quiet dawn, peak 20h). */
function hourWeight(hour: number): number {
  const curve = [
    0.2, 0.14, 0.1, 0.08, 0.08, 0.12, 0.22, 0.4, 0.62, 0.78, 0.86, 0.92, 0.95,
    0.98, 1.0, 0.98, 0.94, 0.95, 1.0, 1.08, 1.12, 0.92, 0.62, 0.36,
  ];
  return curve[hour] ?? 0.5;
}

async function main() {
  console.log(`ClickHouse ${CH_URL} — seeding site "${SLUG}" (id ${SITE_ID})`);

  await ch("DROP TABLE IF EXISTS default.dim_sites");
  await ch(`CREATE TABLE default.dim_sites (
      id UInt32, name String, team UInt32
    ) ENGINE = MergeTree ORDER BY id`);

  await ch("DROP TABLE IF EXISTS default.fact_usage_daily_view");
  await ch(`CREATE TABLE default.fact_usage_daily_view (
      site_id UInt32, date Date, host String, cache_status String,
      status_code UInt32, country String, requests UInt64,
      bandwidth_bytes UInt64, upstream_latency_ms Float64
    ) ENGINE = MergeTree ORDER BY (site_id, date)`);

  await ch("DROP TABLE IF EXISTS default.fact_usage_hourly_view");
  await ch(`CREATE TABLE default.fact_usage_hourly_view (
      site_id UInt32, utc_hour DateTime, host String, cache_status String,
      status_code UInt32, country String, requests UInt64,
      bandwidth_bytes UInt64, upstream_latency_ms Float64
    ) ENGINE = MergeTree ORDER BY (site_id, utc_hour)`);

  await ch("DROP TABLE IF EXISTS default.fact_top_urls_daily_view");
  await ch(`CREATE TABLE default.fact_top_urls_daily_view (
      site_id UInt32, date Date, url String, cache_status String,
      status_code UInt32, requests UInt64, bandwidth_bytes UInt64
    ) ENGINE = MergeTree ORDER BY (site_id, date)`);

  await ch("DROP TABLE IF EXISTS default.fact_analytics_daily_view");
  await ch(`CREATE TABLE default.fact_analytics_daily_view (
      site_id UInt32, date Date, type String, utm_source String,
      country String, device_type String, events UInt64,
      unique_visitors UInt64, unique_sessions UInt64
    ) ENGINE = MergeTree ORDER BY (site_id, date)`);

  await ch("DROP TABLE IF EXISTS default.fact_shared_infra_usage_daily_view");
  await ch(`CREATE TABLE default.fact_shared_infra_usage_daily_view (
      origin_host String, date Date, cache_status String,
      requests UInt64, bandwidth_bytes UInt64
    ) ENGINE = MergeTree ORDER BY (origin_host, date)`);

  await insert("dim_sites", [
    { id: SITE_ID, name: SLUG, team: 7 },
    // A decoy whose name CONTAINS the slug — proves the route's exact `name =`
    // match (an ILIKE would bleed this site's numbers into the tab).
    { id: SITE_ID + 1, name: `${SLUG}-staging`, team: 7 },
  ]);

  const usageDaily: unknown[] = [];
  const topUrls: unknown[] = [];
  const analytics: unknown[] = [];
  const shared: unknown[] = [];

  for (let daysAgo = 0; daysAgo < DAYS; daysAgo++) {
    const date = dayOffset(daysAgo);
    const day = isoDate(date);
    const w = trafficWeight(daysAgo, date);

    for (const host of HOSTS) {
      const hostShare = host === HOSTS[1] ? 1 : host === HOSTS[2] ? 0.35 : 0.12;
      for (const cache of CACHE) {
        const cacheShare =
          cache === "hit"
            ? 1
            : cache === "miss"
              ? 0.22
              : cache === "dynamic"
                ? 0.14
                : 0.05;
        for (const status of new Set(STATUS)) {
          const statusShare =
            status === 200
              ? 1
              : status === 304
                ? 0.18
                : status === 301
                  ? 0.06
                  : status === 404
                    ? 0.03
                    : 0.004;
          for (const country of COUNTRIES) {
            const countryShare = country === "BR" ? 1 : 0.06 + rnd() * 0.12;
            const requests = jitter(
              14_000 * w * hostShare * cacheShare * statusShare * countryShare,
            );
            if (requests < 2) continue;
            usageDaily.push({
              site_id: SITE_ID,
              date: day,
              host,
              cache_status: cache,
              status_code: status,
              country,
              requests,
              bandwidth_bytes:
                requests * jitter(cache === "hit" ? 9_000 : 26_000, 0.2),
              upstream_latency_ms:
                cache === "hit" ? 0 : Math.round(60 + rnd() * 380),
            });
          }
        }
      }
    }

    for (const url of PATHS) {
      const head = PATHS.indexOf(url) < 4 ? 1 : 0.18;
      for (const cache of ["hit", "miss", "dynamic"] as const) {
        const requests = jitter(9_000 * w * head * (cache === "hit" ? 1 : 0.2));
        topUrls.push({
          site_id: SITE_ID,
          date: day,
          url,
          cache_status: cache,
          status_code: url === "/institucional/trocas-e-devolucoes" ? 404 : 200,
          requests,
          bandwidth_bytes: requests * jitter(12_000, 0.2),
        });
      }
    }

    for (const type of EVENT_TYPES) {
      const typeShare =
        type === "PageView"
          ? 1
          : type === "Search"
            ? 0.22
            : type === "AddToCart"
              ? 0.09
              : 0.018;
      for (const utm of UTM_SOURCES) {
        const utmShare = utm === "google" ? 1 : utm === "direct" ? 0.62 : 0.28;
        for (const device of DEVICES) {
          const deviceShare =
            device === "mobile" ? 1 : device === "desktop" ? 0.42 : 0.06;
          for (const country of COUNTRIES.slice(0, 5)) {
            const countryShare = country === "BR" ? 1 : 0.08;
            const events = jitter(
              2_400 * w * typeShare * utmShare * deviceShare * countryShare,
            );
            if (events < 2) continue;
            analytics.push({
              site_id: SITE_ID,
              date: day,
              type,
              utm_source: utm,
              country,
              device_type: device,
              events,
              unique_visitors: Math.max(1, Math.round(events * 0.42)),
              unique_sessions: Math.max(1, Math.round(events * 0.55)),
            });
          }
        }
      }
    }

    // Shared-infra facts are keyed only by origin host (no site_id) — that's the
    // join the summary card merges in, so seed the same hosts.
    for (const host of HOSTS) {
      for (const cache of ["hit", "miss"] as const) {
        const requests = jitter(2_100 * w * (cache === "hit" ? 1 : 0.3));
        shared.push({
          origin_host: host,
          date: day,
          cache_status: cache,
          requests,
          bandwidth_bytes: requests * jitter(7_500, 0.2),
        });
      }
    }
  }

  // Hourly facts back the single-day presets (today / yesterday) and any custom
  // range of two days or less.
  const usageHourly: unknown[] = [];
  for (let daysAgo = 0; daysAgo < 3; daysAgo++) {
    const date = dayOffset(daysAgo);
    const w = trafficWeight(daysAgo, date);
    const maxHour = daysAgo === 0 ? new Date().getUTCHours() : 23;
    for (let hour = 0; hour <= maxHour; hour++) {
      const stamp = new Date(date);
      stamp.setUTCHours(hour);
      const utcHour = stamp.toISOString().slice(0, 19).replace("T", " ");
      for (const host of HOSTS) {
        const hostShare = host === HOSTS[1] ? 1 : 0.3;
        for (const cache of CACHE) {
          const cacheShare =
            cache === "hit" ? 1 : cache === "miss" ? 0.22 : 0.07;
          for (const status of new Set(STATUS)) {
            const statusShare =
              status === 200
                ? 1
                : status === 304
                  ? 0.18
                  : status >= 500
                    ? 0.004
                    : 0.05;
            for (const country of COUNTRIES.slice(0, 5)) {
              const requests = jitter(
                700 *
                  w *
                  hourWeight(hour) *
                  hostShare *
                  cacheShare *
                  statusShare *
                  (country === "BR" ? 1 : 0.09),
              );
              if (requests < 2) continue;
              usageHourly.push({
                site_id: SITE_ID,
                utc_hour: utcHour,
                host,
                cache_status: cache,
                status_code: status,
                country,
                requests,
                bandwidth_bytes:
                  requests * jitter(cache === "hit" ? 9_000 : 26_000, 0.2),
                upstream_latency_ms:
                  cache === "hit" ? 0 : Math.round(60 + rnd() * 380),
              });
            }
          }
        }
      }
    }
  }

  await insert("fact_usage_daily_view", usageDaily);
  await insert("fact_usage_hourly_view", usageHourly);
  await insert("fact_top_urls_daily_view", topUrls);
  await insert("fact_analytics_daily_view", analytics);
  await insert("fact_shared_infra_usage_daily_view", shared);

  const summary = await ch(
    `SELECT toString(min(date)) AS since, toString(max(date)) AS until,
            sum(requests) AS requests, formatReadableSize(sum(bandwidth_bytes)) AS bandwidth
       FROM default.fact_usage_daily_view WHERE site_id = ${SITE_ID} FORMAT JSONEachRow`,
  );
  console.log("done:", summary.trim());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
