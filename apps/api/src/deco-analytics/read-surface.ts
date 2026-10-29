/**
 * Reads from the Deco Analytics read surface (`ANALYTICS_URL`), shared by the
 * Deco Analytics tab (`api/routes/hosting.ts`) and the Monitor's audience
 * views (`api/routes/monitor-audience.ts`).
 *
 * The read surface trusts whoever holds the master token to name any site, so
 * both halves of tenancy live here: the warehouse site_id is resolved from a
 * slug the caller already proved the org owns, never from client input, and a
 * payload the warehouse did not scope to that id is refused.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

/** slug → warehouse site_id (`s<id>`), memoised briefly. The mapping is stable
 *  for the life of a registration, so a short TTL keeps a screenful of view
 *  requests from each re-asking the control-plane while still noticing an
 *  unregister within a few seconds. `null` (not-registered) is cached too, so an
 *  unregistered site doesn't hammer the upstream on every expand — but a
 *  transient resolve FAILURE is never cached (see the `error` result below). */
const siteIdCache = new Map<string, { id: string | null; exp: number }>();
const SITE_ID_TTL_MS = 30_000;

/** Three distinct outcomes so a transient status failure is not mistaken for a
 *  genuine "not registered": the caller renders Configuration only for
 *  `unregistered`, and 502s for `error`. */
export type SiteIdResolution =
  | { status: "registered"; id: string }
  | { status: "unregistered" }
  | { status: "error" };

export async function resolveWarehouseSiteId(
  org: { id: string },
  site: string,
  controlplaneRestUrl: string,
  controlplaneServiceToken: string,
): Promise<SiteIdResolution> {
  const cacheKey = `${org.id}:${site.toLowerCase()}`;
  const now = Date.now();
  const hit = siteIdCache.get(cacheKey);
  if (hit && hit.exp > now) {
    return hit.id
      ? { status: "registered", id: hit.id }
      : { status: "unregistered" };
  }

  let id: string | null = null;
  try {
    const res = await fetch(
      `${controlplaneRestUrl}/sites/${encodeURIComponent(site)}/analytics/status`,
      {
        headers: {
          Authorization: `Bearer ${controlplaneServiceToken}`,
          Accept: "application/json",
        },
      },
    );
    const body = (await res.json().catch(() => null)) as {
      registered?: boolean;
      config?: { id?: string } | null;
    } | null;
    // A non-2xx status is a resolution FAILURE, not "not registered": caching it
    // as unregistered would strand a real registration behind the Configuration
    // screen for the whole TTL. Surface it so the caller 502s instead.
    if (!res.ok) {
      console.error(
        `[analytics] status resolve HTTP ${res.status} for site="${site}"`,
      );
      return { status: "error" };
    }
    // `config.id` is the `s<id>` and is only present once the site is registered.
    if (body?.registered && body.config?.id) {
      id = body.config.id;
    }
  } catch (err) {
    console.error(`[analytics] status resolve failed for site="${site}":`, err);
    // Transient failure — do NOT cache, so the next request retries.
    return { status: "error" };
  }

  // Evict expired entries on write so the map can't grow without bound on a
  // long-lived multi-tenant process (the TTL previously only gated reads).
  for (const [key, entry] of siteIdCache) {
    if (entry.exp <= now) siteIdCache.delete(key);
  }
  siteIdCache.set(cacheKey, { id, exp: now + SITE_ID_TTL_MS });
  return id ? { status: "registered", id } : { status: "unregistered" };
}

export type AnalyticsViewRead =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: ContentfulStatusCode; error: string };

/**
 * One view from the read surface for a resolved warehouse site id, with
 * delivery and metering internals stripped. `params` carries view-specific
 * query values (heatmap page and device, segment filters, goal, currency, prop).
 */
export async function readAnalyticsView(opts: {
  analyticsDataUrl: string;
  analyticsMasterToken: string;
  siteId: string;
  view: string;
  range: string;
  params?: Record<string, string | readonly string[]>;
  /** For log lines only. */
  site: string;
}): Promise<AnalyticsViewRead> {
  const upstream = new URL(`${opts.analyticsDataUrl}/data`);
  upstream.searchParams.set("view", opts.view);
  upstream.searchParams.set("range", opts.range);
  upstream.searchParams.set("site", opts.siteId);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (typeof value === "string") upstream.searchParams.set(key, value);
    else for (const v of value) upstream.searchParams.append(key, v);
  }

  let payload: Record<string, unknown> | null;
  try {
    const res = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${opts.analyticsMasterToken}`,
        Accept: "application/json",
      },
    });
    payload = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      const error =
        (payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : null) ?? `Analytics request failed (${res.status})`;
      return {
        ok: false,
        status:
          res.status >= 400 && res.status <= 599
            ? (res.status as ContentfulStatusCode)
            : 502,
        error,
      };
    }
  } catch (err) {
    console.error(`[analytics] data proxy error for site="${opts.site}":`, err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach analytics service",
    };
  }

  if (!payload) {
    return {
      ok: false,
      status: 502,
      error: "analytics returned an empty payload",
    };
  }

  // A payload that isn't tenant-scoped — or was scoped to a different site —
  // could be someone else's numbers under this customer's name, which is the
  // one outcome that must never render.
  const scope = (payload.usageScope ?? null) as {
    site?: string | null;
    reader?: string;
    tenantScoped?: boolean;
  } | null;
  if (
    !scope ||
    scope.tenantScoped !== true ||
    scope.reader !== "stats_reader" ||
    scope.site !== opts.siteId
  ) {
    console.error(
      `[analytics] refusing unscoped payload for site="${opts.site}" (${opts.siteId}):`,
      scope,
    );
    return {
      ok: false,
      status: 502,
      error: "analytics did not scope to this site; refusing to render",
    };
  }

  // This ships in the open-source Studio and must expose only what a site
  // owner needs, never how we deliver or meter. `worker` is the collector's
  // live metrics; `install` carries bundle bytes and probe results. usageScope
  // is reduced to the fact the client needs (it's scoped) without leaking the
  // enforced-tables list.
  delete payload.worker;
  delete payload.install;
  payload.usageScope = { site: opts.siteId, tenantScoped: true };
  return { ok: true, payload };
}

/** The read surface's suggestions for one filter dimension: the values it has
 *  in the range, by traffic. Read as the tenant upstream, like every view. */
export async function readAnalyticsValues(opts: {
  analyticsDataUrl: string;
  analyticsMasterToken: string;
  siteId: string;
  dim: string;
  range: string;
  site: string;
}): Promise<AnalyticsViewRead> {
  const upstream = new URL(`${opts.analyticsDataUrl}/values`);
  upstream.searchParams.set("dim", opts.dim);
  upstream.searchParams.set("range", opts.range);
  upstream.searchParams.set("site", opts.siteId);
  try {
    const res = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${opts.analyticsMasterToken}`,
        Accept: "application/json",
      },
    });
    const payload = (await res.json().catch(() => null)) as {
      values?: unknown;
    } | null;
    if (!res.ok || !payload) {
      return {
        ok: false,
        status: 502,
        error: `Analytics values failed (${res.status})`,
      };
    }
    return {
      ok: true,
      payload: { values: Array.isArray(payload.values) ? payload.values : [] },
    };
  } catch (err) {
    console.error(
      `[analytics] values proxy error for site="${opts.site}":`,
      err,
    );
    return {
      ok: false,
      status: 502,
      error: "Failed to reach analytics service",
    };
  }
}

/** The live map's renderer, which the read surface builds and serves behind
 *  the same master token as the data, so the browser never holds it. */
export async function readGlobeBundle(opts: {
  analyticsDataUrl: string;
  analyticsMasterToken: string;
}): Promise<{ ok: true; body: string } | { ok: false; status: 404 | 502 }> {
  try {
    const res = await fetch(`${opts.analyticsDataUrl}/globe.js`, {
      headers: { Authorization: `Bearer ${opts.analyticsMasterToken}` },
    });
    if (res.status === 404) return { ok: false, status: 404 };
    if (!res.ok) return { ok: false, status: 502 };
    return { ok: true, body: await res.text() };
  } catch (err) {
    console.error("[analytics] globe bundle proxy error:", err);
    return { ok: false, status: 502 };
  }
}
