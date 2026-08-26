/**
 * Hosting API Route (BFF proxy to the Deco control-plane REST API)
 *
 * Read-only per-site hosting data (deployments / env vars / redirects) proxied
 * server-side so the control-plane service token never reaches the browser.
 * The client only ever sees the proxied JSON and the `hostingEnabled` flag on
 * the public config.
 *
 * Required env vars (see settings/resolve-config.ts):
 *   CONTROLPLANE_REST_URL        – control-plane REST base, e.g.
 *                                  https://control-plane.infra.deco.cx/api/v1
 *   CONTROLPLANE_SERVICE_TOKEN   – Bearer token for the control-plane REST API
 *
 * When either is unset the routes return 503 "not configured" and the Hosting
 * tab stays hidden (public-config `hostingEnabled` is false).
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { StudioContext } from "../../core/studio-context";
import { requireOrganization } from "../../core/studio-context";
import { getSettings } from "../../settings";

type Variables = { studioContext: StudioContext };

/**
 * Proxy one read-only sub-resource of a site to the control-plane REST API.
 * Attaches the service token server-side and forwards the upstream JSON,
 * propagating a non-2xx upstream status as a matching status + `{ error }`.
 */
async function proxyControlplane(
  c: import("hono").Context<{ Variables: Variables }>,
  sub: "deployments" | "env" | "redirects",
) {
  const ctx = c.get("studioContext");
  // Org scope is resolved by `resolveOrgFromPath` upstream; assert membership.
  requireOrganization(ctx);

  const { controlplaneRestUrl, controlplaneServiceToken } = getSettings();
  if (!controlplaneRestUrl || !controlplaneServiceToken) {
    return c.json({ error: "Hosting integration is not configured" }, 503);
  }

  const site = c.req.param("site");
  if (!site) {
    return c.json({ error: "site is required" }, 400);
  }

  try {
    const res = await fetch(
      `${controlplaneRestUrl}/sites/${encodeURIComponent(site)}/${sub}`,
      {
        headers: {
          Authorization: `Bearer ${controlplaneServiceToken}`,
          Accept: "application/json",
        },
      },
    );

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const error =
        (body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : null) ?? `Control-plane request failed (${res.status})`;
      // Clamp to a valid HTTP error status; default to 502 for anything odd.
      const status: ContentfulStatusCode =
        res.status >= 400 && res.status <= 599
          ? (res.status as ContentfulStatusCode)
          : 502;
      return c.json({ error }, status);
    }

    return c.json(body);
  } catch (err) {
    console.error(`[hosting] proxy error (${sub}) for site="${site}":`, err);
    return c.json({ error: "Failed to reach hosting service" }, 502);
  }
}

/**
 * Org-scoped routes mounted at `/api/:org/hosting`. Read-only for now:
 * deployments / env / redirects lists. Write/deploy actions are a follow-up.
 */
export const createHostingRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  // GET /api/:org/hosting/:site/deployments
  app.get("/:site/deployments", (c) => proxyControlplane(c, "deployments"));

  // GET /api/:org/hosting/:site/env
  app.get("/:site/env", (c) => proxyControlplane(c, "env"));

  // GET /api/:org/hosting/:site/redirects
  app.get("/:site/redirects", (c) => proxyControlplane(c, "redirects"));

  return app;
};
