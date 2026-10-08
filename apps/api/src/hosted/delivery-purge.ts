/**
 * Purging latest.json from Cloudflare's edge after Studio rewrites it.
 *
 * latest.json is served `s-maxage=3600`: the edge may hold it up to an hour.
 * Every write (Publish, Make current) is followed by a purge of that
 * URL through the zone's purge_cache API, so the new pointer is seen at once.
 * Each attempt has a 5 s timeout and a failed attempt is retried exactly once
 * (two attempts at most). If both fail, the operation fails: Studio shows it
 * and the user retries from there. The hour bounds staleness.
 */

import { getSettings } from "@/settings";
import { DELIVERY_ORIGIN } from "./delivery-store";

export interface DeliveryPurge {
  /** Purges the public URL of the delivery object `key`; throws on failure. */
  purge(key: string): Promise<void>;
}

/** How long one purge attempt may take before it counts as failed. */
const PURGE_TIMEOUT_MS = 5000;

/** One attempt plus exactly one retry. */
const PURGE_ATTEMPTS = 2;

export function createDeliveryPurge(config: {
  zoneId: string | undefined;
  apiToken: string | undefined;
  publicOrigin?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  warn?: (message: string) => void;
}): DeliveryPurge {
  const { zoneId, apiToken } = config;
  if (!zoneId || !apiToken) {
    const warn = config.warn ?? console.warn;
    return {
      async purge(key) {
        warn(
          `hosted delivery: Cloudflare purge not configured; skipped purging ${key} (the edge may serve the previous copy for up to 1 h)`,
        );
      },
    };
  }
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? PURGE_TIMEOUT_MS;
  const origin = new URL(config.publicOrigin ?? DELIVERY_ORIGIN).origin;
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;
  return {
    async purge(key) {
      const url = `${origin}/${key}`;
      const attempt = async () => {
        let res: Response;
        try {
          res = await doFetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ files: [url] }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          throw new Error(
            name === "TimeoutError"
              ? `purge ${url}: timed out after ${timeoutMs} ms`
              : `purge ${url}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const body = (await res.json().catch(() => null)) as {
          success?: unknown;
        } | null;
        if (!res.ok || body?.success !== true) {
          throw new Error(`purge ${url}: HTTP ${res.status}`);
        }
      };
      for (let i = 1; ; i++) {
        try {
          return await attempt();
        } catch (error) {
          if (i >= PURGE_ATTEMPTS) throw error;
        }
      }
    },
  };
}

/** The configured purge; unconfigured (local/dev/tests) it skips with a warning. */
export function deliveryPurge(): DeliveryPurge {
  const s = getSettings();
  return createDeliveryPurge({
    zoneId: s.cfDeliveryZoneId,
    apiToken: s.cfPurgeApiToken,
    publicOrigin: s.deliveryPublicOrigin,
  });
}
