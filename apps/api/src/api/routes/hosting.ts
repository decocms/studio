/**
 * Hosting API Route (BFF proxy to the Deco control-plane REST API)
 *
 * Per-site data proxied server-side so the control-plane service token never
 * reaches the browser. The client only ever sees the proxied JSON and the
 * `hostingEnabled` flag on the public config. The same control-plane connection
 * powers three peer tabs — Hosting, E2E, and Deco Analytics — so all of their
 * traffic flows through this one BFF proxy.
 *
 * Surfaces (reads and writes):
 *   - Hosting:   deployments (read) / env (read + PUT replace-set) /
 *                secrets (read names + PUT + DELETE) / redirects (read + PUT +
 *                DELETE) / deploy (POST re-deploy of the current commit)
 *   - E2E:       e2e/runs (list + POST to queue a run) and e2e/runs/:runId
 *                (detail)
 *   - Analytics: lifecycle (status/register/config/disable/usage/delete) proxied
 *                to the control-plane; PLUS analytics/data — the tenant-scoped
 *                dashboard views read straight from the Analytics read surface
 *                (a different upstream), scoped by a warehouse site_id this BFF
 *                resolves from an owned slug and never from the client.
 *
 * Required env vars (see settings/resolve-config.ts):
 *   CONTROLPLANE_REST_URL        – control-plane REST base, e.g.
 *                                  https://control-plane.infra.deco.cx/api/v1
 *   CONTROLPLANE_SERVICE_TOKEN   – Bearer token for the control-plane REST API
 *   ANALYTICS_URL                – Analytics read surface base, e.g.
 *                                  https://analytics.infra.deco.cx (data views)
 *   ANALYTICS_MASTER_TOKEN       – Bearer token for the read surface; the
 *                                  warehouse row policies clamp per site as a
 *                                  backstop, but this token never reaches the
 *                                  browser
 *
 * When either is unset the routes return 503 "not configured" and the tabs
 * stay hidden (public-config `hostingEnabled` is false).
 */

import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { hasAdminRole } from "@decocms/shared/auth/roles";
import type { StudioContext } from "../../core/studio-context";
import {
  isAuthenticated,
  requireOrganization,
} from "../../core/studio-context";
import { getSettings } from "../../settings";
import {
  readAnalyticsValues,
  readAnalyticsView,
  readGlobeBundle,
  resolveWarehouseSiteId,
} from "../../deco-analytics/read-surface";

type Variables = { studioContext: StudioContext };

/**
 * Proxy one sub-path of a site to the control-plane REST API. Attaches the
 * service token server-side and forwards the upstream JSON, propagating the
 * upstream status (2xx and errors alike) as a matching status + `{ error }` on
 * failure (so the control-plane's 503 `not_configured` reaches the client
 * intact, and a 202 from `deploy`/`e2e` stays a 202).
 *
 * `sub` is the site sub-path (e.g. `deployments`, `e2e/runs`,
 * `secrets/API_KEY`). Options:
 *   - `method`       – upstream HTTP method (default `GET`)
 *   - `forwardQuery` – request query params to pass through to the upstream
 *   - `body`         – JSON body to forward (send `Content-Type: application/json`)
 */
async function proxyControlplane(
  c: Context<{ Variables: Variables }>,
  sub: string,
  opts: {
    method?: string;
    forwardQuery?: readonly string[];
    body?: unknown;
  } = {},
) {
  const { method = "GET", forwardQuery = [], body } = opts;
  const ctx = c.get("studioContext");
  // Require an authenticated principal. `resolveOrgFromPath` 403s an authenticated
  // NON-member but deliberately lets ANONYMOUS requests fall through to the route
  // (so OAuth discovery / public-share reads work), so this BFF must reject the
  // anonymous case itself — otherwise anyone could read a site's hosting / e2e /
  // analytics data by naming a known org+site slug. Membership is already proven
  // upstream for any authenticated principal; ownership is proven just below.
  if (!isAuthenticated(ctx)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // A present-but-unparseable body must not fall through as `{}` — for a
  // replace-set write (PUT /env) that would wipe the whole environment.
  if (body === MALFORMED_BODY) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const org = requireOrganization(ctx);

  const { controlplaneRestUrl, controlplaneServiceToken } = getSettings();
  if (!controlplaneRestUrl || !controlplaneServiceToken) {
    return c.json({ error: "Hosting integration is not configured" }, 503);
  }

  const site = c.req.param("site");
  if (!site) {
    return c.json({ error: "site is required" }, 400);
  }

  // Access control lives ENTIRELY here — the control-plane trusts this BFF's
  // single super-admin service token and does NO tenant scoping of its own, so
  // isolation between orgs is this guard's job and this guard's job only.
  //
  // 1) Ownership (the org↔slug de-para): the `:site` must be a slug the caller's
  //    org actually owns (`org_sites`). Membership in the org (already checked
  //    upstream) is NOT enough — without this, a member of one org could read or
  //    mutate another org's site just by putting its slug in the URL. Answer 404
  //    (not 403) so an unowned slug is indistinguishable from a non-existent one.
  const ownsSite = await ctx.storage.orgSites.isOwnedBy(
    site.toLowerCase(),
    org.id,
  );
  if (!ownsSite) {
    return c.json({ error: "Site not found in organization" }, 404);
  }

  // 2) Write gate: every member may READ, but mutations (PUT/POST/DELETE) need
  //    an admin/owner role. Fail closed — an absent/unknown role is not an admin.
  //    (A finer Better Auth permission can replace this role check later.)
  const isWrite = method.toUpperCase() !== "GET";
  if (isWrite && !hasAdminRole(ctx.access.getRole())) {
    return c.json(
      { error: "You don't have permission to modify this site's hosting" },
      403,
    );
  }

  const upstream = new URL(
    `${controlplaneRestUrl}/sites/${encodeURIComponent(site)}/${sub}`,
  );
  for (const key of forwardQuery) {
    const value = c.req.query(key);
    if (value != null) upstream.searchParams.set(key, value);
  }

  const hasBody = body !== undefined;

  try {
    const res = await fetch(upstream, {
      method,
      headers: {
        Authorization: `Bearer ${controlplaneServiceToken}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const error =
        (payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : null) ?? `Control-plane request failed (${res.status})`;
      // Clamp to a valid HTTP error status; default to 502 for anything odd.
      const status: ContentfulStatusCode =
        res.status >= 400 && res.status <= 599
          ? (res.status as ContentfulStatusCode)
          : 502;
      return c.json({ error }, status);
    }

    // Propagate the upstream 2xx status (e.g. 202 Accepted from deploy/e2e).
    const okStatus: ContentfulStatusCode =
      res.status >= 200 && res.status <= 299
        ? (res.status as ContentfulStatusCode)
        : 200;
    return c.json(payload ?? {}, okStatus);
  } catch (err) {
    console.error(`[hosting] proxy error (${sub}) for site="${site}":`, err);
    return c.json({ error: "Failed to reach hosting service" }, 502);
  }
}

/**
 * Sentinel for a body that was present but not valid JSON. Distinct from `{}`
 * (an empty body) so a write route can 400 instead of forwarding it: coercing a
 * parse failure to `{}` is fail-open — for the replace-set PUT /env it silently
 * wipes the site's whole environment. `proxyControlplane` rejects it.
 */
const MALFORMED_BODY = Symbol("hosting.malformed-body");

/**
 * Read a JSON request body. An empty body reads as `{}` (some writes carry
 * none); a body that is present but unparseable reads as {@link MALFORMED_BODY}
 * so the write is rejected rather than fail-open.
 */
async function readJsonBody(
  c: Context<{ Variables: Variables }>,
): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return MALFORMED_BODY;
  }
}

// --- Analytics read surface (the tenant-scoped /data views) -----------------
//
// Registration lives in the control-plane (proxied above). READING does not:
// the data views come straight from the Deco Analytics read surface, which is a
// different upstream (ANALYTICS_URL) with its own master token. The spec is
// explicit — "leitura não passa pelo control-plane".
//
// Two things this BFF must get right, because the read surface trusts whoever
// holds the master token to name any site:
//   1. It resolves the warehouse site_id (`s<id>`) itself, from a slug the org
//      OWNS — never from a client-supplied value, which could name another
//      tenant. The id only exists on the control-plane, so we read it back from
//      `analytics/status` (`config.id`) and cache it briefly.
//   2. It refuses to hand back a payload the warehouse did NOT scope: if
//      `usageScope.tenantScoped` isn't true, or the reader wasn't the
//      tenant-scoped one, or the scoped site doesn't match, the numbers could be
//      someone else's — so we 502 rather than render them.

/** Views the customer-facing tab may ask for. `pipeline` is deliberately absent:
 *  it reads `system.parts`, which cannot carry a tenant row policy, so it is an
 *  operator-only view and must never reach a customer screen. */
const ANALYTICS_VIEWS = new Set([
  "live",
  "overview",
  "behaviour",
  "events",
  "errors",
  "experiments",
  "vitals",
  "quality",
  "usage",
  "install",
  "heatmap",
]);

const HEATMAP_DEVICES = new Set(["mobile", "tablet", "desktop"]);

/** The heatmap view's own filters, validated before they reach the read
 *  surface (which falls back to `/` and `mobile` on anything else — answering
 *  for a page nobody asked about). Absent values keep the read surface's
 *  defaults. Returns `null` when a value is present but invalid. */
export function heatmapParams(
  page: string | undefined,
  device: string | undefined,
): { page?: string; device?: string } | null {
  if (page !== undefined && (!page.startsWith("/") || page.length > 512)) {
    return null;
  }
  if (device !== undefined && !HEATMAP_DEVICES.has(device)) return null;
  return {
    ...(page !== undefined ? { page } : {}),
    ...(device !== undefined ? { device } : {}),
  };
}

/** The dimensions a segment can filter on, as the read surface names them
 *  (queries.mjs DIMENSIONS). */
const ANALYTICS_DIMENSIONS = new Set([
  "path",
  "source",
  "device",
  "browser",
  "os",
  "country",
  "region",
  "city",
  "name",
  "channel",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "flag",
  "exp",
  "prop",
]);
const ANALYTICS_OPERATORS = new Set(["is", "not", "has", "starts"]);
const MAX_ANALYTICS_FILTERS = 10;

/** A view's segment and reading: repeated `f=<dim>:<op>:<value>` filters, the
 *  conversion goal, the currency money is shown in and the property whose
 *  values the events view lists. Validated before they reach the read surface,
 *  which ignores an unknown dimension instead of refusing it — a segment that
 *  silently reads as the whole site. `null` when anything present is invalid. */
export function analyticsQueryParams(input: {
  f: readonly string[];
  goal?: string;
  currency?: string;
  prop?: string;
}): Record<string, string | string[]> | null {
  if (input.f.length > MAX_ANALYTICS_FILTERS) return null;
  for (const raw of input.f) {
    const [dim, op, ...rest] = raw.split(":");
    const value = rest.join(":");
    if (
      !dim ||
      !ANALYTICS_DIMENSIONS.has(dim) ||
      !op ||
      !ANALYTICS_OPERATORS.has(op) ||
      value.length === 0 ||
      value.length > 200
    ) {
      return null;
    }
  }
  if (input.goal !== undefined && !/^[\w-]{1,64}$/.test(input.goal)) {
    return null;
  }
  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) {
    return null;
  }
  if (
    input.prop !== undefined &&
    (input.prop.length === 0 || input.prop.length > 100)
  ) {
    return null;
  }
  return {
    ...(input.f.length ? { f: [...input.f] } : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.prop !== undefined ? { prop: input.prop } : {}),
  };
}

/** The ranges the read surface understands (queries.mjs RANGES). */
const ANALYTICS_RANGES = new Set([
  "5m",
  "15m",
  "30m",
  "1h",
  "24h",
  "7d",
  "30d",
]);

/**
 * Org-scoped routes mounted at `/api/:org/hosting`. Three peer surfaces
 * (Hosting / E2E / Deco Analytics) over the same control-plane connection.
 * Reads and writes both proxy through `proxyControlplane`, so the service token
 * never leaves the server.
 */
export const createHostingRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  // GET /api/:org/hosting/:site/access — LOCAL ownership + role check, no
  // control-plane call. The tab bar calls this to decide whether to render the
  // Hosting / E2E / Analytics tabs AT ALL: they must surface only for a slug the
  // caller's org actually owns (`org_sites`), never for every site just because
  // the deployment has hosting wired. Mirrors the ownership + write gate in
  // `proxyControlplane` so the tabs and their data agree on visibility.
  // Answers 200 `{ owned:false }` (not 404) so the client gets a definitive,
  // cacheable signal to hide the tabs, not an error to disambiguate.
  app.get("/:site/access", async (c) => {
    const ctx = c.get("studioContext");
    if (!isAuthenticated(ctx)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const org = requireOrganization(ctx);
    const site = c.req.param("site");
    if (!site) {
      return c.json({ error: "site is required" }, 400);
    }
    const owned = await ctx.storage.orgSites.isOwnedBy(
      site.toLowerCase(),
      org.id,
    );
    return c.json({
      owned,
      canWrite: owned && hasAdminRole(ctx.access.getRole()),
    });
  });

  // --- Hosting (reads) ---
  // Register the literal `deployments/history` and `deployments/logs` sub-paths
  // BEFORE the plain `deployments` read so the static segments always win over
  // any future `:something` param on that prefix.

  // GET /api/:org/hosting/:site/deployments/history (?limit passthrough) — the
  // deploy timeline (deploy / redeploy / rollback events) the client uses both
  // for the history table and to mark the serving commit's event as "Live".
  app.get("/:site/deployments/history", (c) =>
    proxyControlplane(c, "deployments/history", { forwardQuery: ["limit"] }),
  );

  // GET /api/:org/hosting/:site/deployments/logs (?commit&env passthrough) —
  // build logs for one commit/env. The control-plane answers `configured:false`
  // with a `reason` when the platform has no build-log wiring, else inline
  // `text` + a presigned `url` (expires ~5min, so the client never caches it).
  app.get("/:site/deployments/logs", (c) =>
    proxyControlplane(c, "deployments/logs", {
      forwardQuery: ["commit", "env"],
    }),
  );

  // GET /api/:org/hosting/:site/deployments
  app.get("/:site/deployments", (c) => proxyControlplane(c, "deployments"));

  // GET /api/:org/hosting/:site/env
  app.get("/:site/env", (c) => proxyControlplane(c, "env"));

  // GET /api/:org/hosting/:site/redirects
  app.get("/:site/redirects", (c) => proxyControlplane(c, "redirects"));

  // GET /api/:org/hosting/:site/domains — client-safe DTOs; the control-plane
  // resolves the substrate server-side and returns only host/status/dns.
  app.get("/:site/domains", (c) => proxyControlplane(c, "domains"));

  // GET /api/:org/hosting/:site/secrets — NAMES ONLY (values are never read
  // back); the control-plane answers `{ items: [{ name }] }`.
  app.get("/:site/secrets", (c) => proxyControlplane(c, "secrets"));

  // --- Hosting (writes) ---
  // PUT /api/:org/hosting/:site/env — FULL REPLACE-SET. Body `{ vars: [...] }`
  // is the complete desired list; the control-plane replaces every var with it.
  app.put("/:site/env", async (c) =>
    proxyControlplane(c, "env", {
      method: "PUT",
      body: await readJsonBody(c),
    }),
  );

  // PUT /api/:org/hosting/:site/secrets — body `{ name, value }` (write-only).
  app.put("/:site/secrets", async (c) =>
    proxyControlplane(c, "secrets", {
      method: "PUT",
      body: await readJsonBody(c),
    }),
  );

  // DELETE /api/:org/hosting/:site/secrets/:name?scope=runtime|build — a name can
  // exist in both scopes, so `scope` MUST be forwarded to the control-plane;
  // dropping it would delete the wrong scope's row.
  app.delete("/:site/secrets/:name", (c) =>
    proxyControlplane(c, `secrets/${encodeURIComponent(c.req.param("name"))}`, {
      method: "DELETE",
      forwardQuery: ["scope"],
    }),
  );

  // PUT /api/:org/hosting/:site/redirects — body `{ from, to, type }`
  // (idempotent per `from`: upserts the redirect for that source path).
  app.put("/:site/redirects", async (c) =>
    proxyControlplane(c, "redirects", {
      method: "PUT",
      body: await readJsonBody(c),
    }),
  );

  // DELETE /api/:org/hosting/:site/redirects/:from — `:from` is URL-encoded
  // into the control-plane path.
  app.delete("/:site/redirects/:from", (c) =>
    proxyControlplane(
      c,
      `redirects/${encodeURIComponent(c.req.param("from"))}`,
      { method: "DELETE" },
    ),
  );

  // PUT /api/:org/hosting/:site/domains — body `{ host }` (idempotent per host;
  // attaches the custom domain, wired per substrate server-side).
  app.put("/:site/domains", async (c) =>
    proxyControlplane(c, "domains", {
      method: "PUT",
      body: await readJsonBody(c),
    }),
  );

  // DELETE /api/:org/hosting/:site/domains/:host — `:host` is URL-encoded into
  // the control-plane path.
  app.delete("/:site/domains/:host", (c) =>
    proxyControlplane(c, `domains/${encodeURIComponent(c.req.param("host"))}`, {
      method: "DELETE",
    }),
  );

  // POST /api/:org/hosting/:site/deploy — body `{ mode: "current" }`
  // re-deploys the current production commit. Control-plane answers 202.
  app.post("/:site/deploy", async (c) =>
    proxyControlplane(c, "deploy", {
      method: "POST",
      body: await readJsonBody(c),
    }),
  );

  // --- E2E ---
  // GET /api/:org/hosting/:site/e2e/types — the runnable check types
  // (`{ items: [{ id, label, description }] }`) that populate the Run-test picker.
  app.get("/:site/e2e/types", (c) => proxyControlplane(c, "e2e/types"));

  // GET /api/:org/hosting/:site/e2e/checks — the DECLARED checks + their LIVE
  // phase (`{ items: [{ subject, url, command, schedule, phase, updatedAt }] }`).
  // Distinct from /e2e/runs (finished S3 runs): shows an in-flight check as
  // pending/running the moment it is triggered, before any artifact exists.
  app.get("/:site/e2e/checks", (c) => proxyControlplane(c, "e2e/checks"));

  // DELETE /api/:org/hosting/:site/e2e/checks — tombstone the site's declared
  // check(s) + purge their run history. Write-gated by the proxy (admin role).
  app.delete("/:site/e2e/checks", (c) =>
    proxyControlplane(c, "e2e/checks", { method: "DELETE" }),
  );

  // GET /api/:org/hosting/:site/e2e/runs  (?limit&offset passthrough)
  app.get("/:site/e2e/runs", (c) =>
    proxyControlplane(c, "e2e/runs", { forwardQuery: ["limit", "offset"] }),
  );

  // POST /api/:org/hosting/:site/e2e/runs — body `{ command?, url? }` queues a
  // run. Control-plane answers 202.
  app.post("/:site/e2e/runs", async (c) =>
    proxyControlplane(c, "e2e/runs", {
      method: "POST",
      body: await readJsonBody(c),
    }),
  );

  // GET /api/:org/hosting/:site/e2e/runs/:runId
  // Hono only matches this route when `:runId` is present and non-empty. The
  // detail carries presigned artifact URLs (screenshot/video/trace) that expire
  // ~1h, so the client re-fetches on open and never caches the URLs.
  app.get("/:site/e2e/runs/:runId", (c) =>
    proxyControlplane(
      c,
      `e2e/runs/${encodeURIComponent(c.req.param("runId"))}`,
    ),
  );

  // DELETE /api/:org/hosting/:site/e2e/runs/:runId — removes a run + its
  // artifacts. Control-plane answers `{ runId, deleted: boolean }`.
  app.delete("/:site/e2e/runs/:runId", (c) =>
    proxyControlplane(
      c,
      `e2e/runs/${encodeURIComponent(c.req.param("runId"))}`,
      { method: "DELETE" },
    ),
  );

  // --- Deco Analytics ---
  // The analytics lifecycle: status (read) → register (write) → configure /
  // pause-resume / unregister (writes), plus usage (read). Every write inherits
  // the guard's admin-role gate in `proxyControlplane`.

  // GET /api/:org/hosting/:site/analytics/status — `{ configured, registered,
  // host, config }`. `configured:false` means the collector isn't wired to the
  // environment; `registered:false` means the site can be registered here.
  app.get("/:site/analytics/status", (c) =>
    proxyControlplane(c, "analytics/status"),
  );

  // GET /api/:org/hosting/:site/analytics/usage (?from&to&granularity passthrough)
  // Upstream may answer 503 `not_configured` when analytics isn't set up; that
  // status + body is propagated so the tab can show a friendly empty state.
  app.get("/:site/analytics/usage", (c) =>
    proxyControlplane(c, "analytics/usage", {
      forwardQuery: ["from", "to", "granularity"],
    }),
  );

  // POST /api/:org/hosting/:site/analytics/register — body `{ modules?, host?,
  // sampling? }` registers the site with the Deco Analytics collector.
  app.post("/:site/analytics/register", async (c) =>
    proxyControlplane(c, "analytics/register", {
      method: "POST",
      body: await readJsonBody(c),
    }),
  );

  // POST /api/:org/hosting/:site/analytics/rotate-key — rotate a keyed site's
  // public token (delete + re-register by key under the same warehouse id).
  // Returns the new key + snippet once. 422 for a host-resolved site.
  app.post("/:site/analytics/rotate-key", async (c) =>
    proxyControlplane(c, "analytics/rotate-key", {
      method: "POST",
      body: await readJsonBody(c),
    }),
  );

  // PUT /api/:org/hosting/:site/analytics/disable — body `{ enabled }` pauses or
  // resumes collection without unregistering the site.
  app.put("/:site/analytics/disable", async (c) =>
    proxyControlplane(c, "analytics/disable", {
      method: "PUT",
      body: await readJsonBody(c),
    }),
  );

  // PUT /api/:org/hosting/:site/analytics/config — body `{ modules?, sampling?,
  // tier?, domains?, quota? }` edits the registered site's config. `quota` is
  // set-only upstream (a blank field can't clear an existing cap).
  app.put("/:site/analytics/config", async (c) =>
    proxyControlplane(c, "analytics/config", {
      method: "PUT",
      body: await readJsonBody(c),
    }),
  );

  // DELETE /api/:org/hosting/:site/analytics — unregisters the site and removes
  // its config. Control-plane answers `{ deleted }`.
  app.delete("/:site/analytics", (c) =>
    proxyControlplane(c, "analytics", { method: "DELETE" }),
  );

  /** The org owns the slug and the read surface is wired. Ownership answers
   *  404 (not 403) so an unowned slug looks like a non-existent one, the same
   *  guard as proxyControlplane. */
  async function analyticsAccess(c: Context<{ Variables: Variables }>) {
    const ctx = c.get("studioContext");
    if (!isAuthenticated(ctx)) {
      return { error: c.json({ error: "Unauthorized" }, 401) } as const;
    }
    const org = requireOrganization(ctx);
    const site = c.req.param("site");
    if (!site) {
      return { error: c.json({ error: "site is required" }, 400) } as const;
    }
    const ownsSite = await ctx.storage.orgSites.isOwnedBy(
      site.toLowerCase(),
      org.id,
    );
    if (!ownsSite) {
      return {
        error: c.json({ error: "Site not found in organization" }, 404),
      } as const;
    }
    const {
      controlplaneRestUrl,
      controlplaneServiceToken,
      analyticsDataUrl,
      analyticsMasterToken,
    } = getSettings();
    if (!controlplaneRestUrl || !controlplaneServiceToken) {
      return {
        error: c.json({ error: "Hosting integration is not configured" }, 503),
      } as const;
    }
    if (!analyticsDataUrl || !analyticsMasterToken) {
      return {
        error: c.json(
          { error: "Analytics data surface is not configured" },
          503,
        ),
      } as const;
    }
    return {
      org,
      site,
      controlplaneRestUrl,
      controlplaneServiceToken,
      analyticsDataUrl,
      analyticsMasterToken,
    } as const;
  }

  // GET /api/:org/hosting/:site/analytics/data?view=&range=[&page&device&f&goal&currency&prop]
  app.get("/:site/analytics/data", async (c) => {
    const access = await analyticsAccess(c);
    if ("error" in access) return access.error;
    const { org, site, analyticsDataUrl, analyticsMasterToken } = access;

    const view = c.req.query("view") ?? "overview";
    if (!ANALYTICS_VIEWS.has(view)) {
      return c.json({ error: `unknown or unavailable view: ${view}` }, 400);
    }
    const range = c.req.query("range") ?? "24h";
    if (!ANALYTICS_RANGES.has(range)) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }
    const heatmap =
      view === "heatmap"
        ? heatmapParams(c.req.query("page"), c.req.query("device"))
        : {};
    if (!heatmap) {
      return c.json({ error: "invalid heatmap page or device" }, 400);
    }
    const segment = analyticsQueryParams({
      f: c.req.queries("f") ?? [],
      goal: c.req.query("goal"),
      currency: c.req.query("currency"),
      prop: c.req.query("prop"),
    });
    if (!segment) {
      return c.json({ error: "invalid filter, goal, currency or prop" }, 400);
    }

    // Resolve the warehouse site_id from a slug the org owns — never trust a
    // client-supplied id. `unregistered` ⇒ the tab shows Configuration; a
    // transient resolve `error` ⇒ 502 (distinct from "no registration") so the
    // tab reports a data-load failure instead of a misleading Configuration screen.
    const resolution = await resolveWarehouseSiteId(
      org,
      site,
      access.controlplaneRestUrl,
      access.controlplaneServiceToken,
    );
    if (resolution.status === "error") {
      return c.json({ error: "Failed to resolve analytics registration" }, 502);
    }
    if (resolution.status === "unregistered") {
      return c.json({ registered: false, view, range });
    }
    const siteId = resolution.id;

    const read = await readAnalyticsView({
      analyticsDataUrl,
      analyticsMasterToken,
      siteId,
      view,
      range,
      params: { ...heatmap, ...segment },
      site,
    });
    if (!read.ok) {
      return c.json({ error: read.error }, read.status);
    }

    return c.json({
      registered: true,
      siteId,
      view,
      range,
      data: read.payload,
    });
  });

  // GET /api/:org/hosting/:site/analytics/values?dim=&range= — filter suggestions.
  app.get("/:site/analytics/values", async (c) => {
    const access = await analyticsAccess(c);
    if ("error" in access) return access.error;
    const dim = c.req.query("dim") ?? "";
    if (!ANALYTICS_DIMENSIONS.has(dim)) {
      return c.json({ error: `unknown dimension: ${dim}` }, 400);
    }
    const range = c.req.query("range") ?? "24h";
    if (!ANALYTICS_RANGES.has(range)) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }
    const resolution = await resolveWarehouseSiteId(
      access.org,
      access.site,
      access.controlplaneRestUrl,
      access.controlplaneServiceToken,
    );
    if (resolution.status === "error") {
      return c.json({ error: "Failed to resolve analytics registration" }, 502);
    }
    if (resolution.status === "unregistered") return c.json({ values: [] });
    const read = await readAnalyticsValues({
      analyticsDataUrl: access.analyticsDataUrl,
      analyticsMasterToken: access.analyticsMasterToken,
      siteId: resolution.id,
      dim,
      range,
      site: access.site,
    });
    if (!read.ok) return c.json({ error: read.error }, read.status);
    return c.json(read.payload);
  });

  // GET /api/:org/hosting/:site/analytics/globe.js — the live map renderer, behind the read token.
  app.get("/:site/analytics/globe.js", async (c) => {
    const access = await analyticsAccess(c);
    if ("error" in access) return access.error;
    const bundle = await readGlobeBundle(access);
    if (!bundle.ok) {
      return c.json({ error: "Live map is unavailable" }, bundle.status);
    }
    return c.body(bundle.body, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=3600",
    });
  });

  return app;
};
