/**
 * Purging latest.json from Cloudflare's edge after Studio rewrites it.
 *
 * latest.json is served `s-maxage=3600`: the edge may hold it up to an hour.
 * Every write (Publish, Make current, Resync) is followed by a purge of that
 * one URL through the zone's purge_cache API, so the new pointer is seen at
 * once; the hour is only the safety net that heals a purge that never landed.
 */

import { getSettings } from "@/settings";
import { DELIVERY_ORIGIN } from "./delivery-store";

export interface DeliveryPurge {
  /** Purges the public URL of the delivery object `key`; throws on failure. */
  purge(key: string): Promise<void>;
}

/** Waits between attempts: three attempts in all. */
const RETRY_DELAYS_MS = [250, 1000];

export function createDeliveryPurge(config: {
  zoneId: string | undefined;
  apiToken: string | undefined;
  publicOrigin?: string;
  fetch?: typeof fetch;
  retryDelaysMs?: number[];
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
  const delays = config.retryDelaysMs ?? RETRY_DELAYS_MS;
  const origin = new URL(config.publicOrigin ?? DELIVERY_ORIGIN).origin;
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;
  const attempt = async (url: string) => {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ files: [url] }),
    });
    const body = (await res.json().catch(() => null)) as {
      success?: unknown;
    } | null;
    if (!res.ok || body?.success !== true) {
      throw new Error(`purge ${url}: HTTP ${res.status}`);
    }
  };
  return {
    async purge(key) {
      const url = `${origin}/${key}`;
      for (let i = 0; ; i++) {
        try {
          return await attempt(url);
        } catch (error) {
          if (i >= delays.length) throw error;
          await new Promise((resolve) => setTimeout(resolve, delays[i]));
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
