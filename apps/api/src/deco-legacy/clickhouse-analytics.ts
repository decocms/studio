/**
 * The legacy deco.cx analytics warehouse — a ClickHouse instance separate from
 * the one Studio's own monitoring reads (`CLICKHOUSE_URL`). It holds the CDN /
 * shared-infra usage facts the deco.cx platform bills on.
 *
 * Env vars (all three needed; missing any = feature absent, queries return []):
 *   CLICKHOUSE_ANALYTICS_ADDRESS   – HTTP URL of the warehouse
 *   CLICKHOUSE_ANALYTICS_USERNAME  – read-only user (default "admin_monitor")
 *   CLICKHOUSE_ANALYTICS_PASSWORD  – its password
 */

import { getSettings } from "../settings";

type ClickHouseClient = import("@clickhouse/client").ClickHouseClient;

let clientPromise: Promise<ClickHouseClient> | null = null;

/**
 * The only ceiling we can set from here. This user is `readonly`, which makes
 * ClickHouse reject *any* per-query setting with code 164 — including
 * `max_execution_time`, so unlike monitoring/query-engine.ts there is no
 * server-side cap to pair with this. Bound execution on the warehouse's user
 * profile instead; a timeout here only stops us waiting.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export function isAnalyticsConfigured(): boolean {
  const s = getSettings();
  return !!(s.clickhouseAnalyticsUrl && s.clickhouseAnalyticsPassword);
}

async function getClient(): Promise<ClickHouseClient> {
  if (!clientPromise) {
    const s = getSettings();
    clientPromise = import("@clickhouse/client")
      .then(({ createClient }) =>
        createClient({
          url: s.clickhouseAnalyticsUrl,
          username: s.clickhouseAnalyticsUsername,
          password: s.clickhouseAnalyticsPassword,
          request_timeout: REQUEST_TIMEOUT_MS,
          // Compression is a per-query setting a `readonly` user may not set (164).
        }),
      )
      // Uncache on failure, so a bad boot doesn't wedge the process forever.
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/**
 * Run a read query against the analytics warehouse. Returns [] when the
 * warehouse isn't configured — every caller renders an empty dashboard rather
 * than an error, matching how the legacy admin behaves.
 */
export async function analyticsQuery<T>(
  query: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  if (!isAnalyticsConfigured()) return [];
  const client = await getClient();
  const result = await client.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<T>();
}
