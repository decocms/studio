/**
 * Order monitor reads for the Monitor UI, mounted at `/api/:org/order-monitor`
 * (not under `/monitor`, whose next segment is a site slug a store list would
 * collide with).
 *
 *   GET /ingest                          → the order ingest MCP a store installs
 *   GET /stores                          → each store's verdict per rule
 *   GET /stores/:connectionId/day?at=    → the chart's day, read from the lake
 *   GET /stores/:connectionId/pushes?at=&virtualMcpId= → push markers per repo
 *   GET /traffic?at=&tz=&site=           → the sites' visitors (Deco Analytics), from the lake
 *
 * `:connectionId` must be an active ingest install of the org in the path; the
 * lake read runs as that org's own user regardless.
 */

import type {
  OrderMonitorRuleState,
  OrderMonitorStore,
  OrderMonitorVerdict,
} from "@decocms/shared/order-monitor";
import { Hono } from "hono";
import type { Context } from "hono";
import { orgHasFeature } from "@/core/plan-feature-gate";
import type { StudioContext } from "@/core/studio-context";
import { isAuthenticated, requireOrganization } from "@/core/studio-context";
import { readAnalyticsRegistration } from "@/analytics/registration";
import { isCustomerLakeConfigured } from "@/customer-lake/client";
import { loadStoreInfo } from "@/monitoring/order-incidents";
import { loadStoreDay, loadStoreTimezone } from "@/monitoring/order-lake";
import { listPushes } from "@/monitoring/order-pushes";
import { loadSiteTraffic } from "@/monitoring/site-traffic";
import { isTimezone } from "@/monitoring/timezone";
import { buildDayView, RULES, type Rule } from "@/monitoring/order-rules";
import { getSettings } from "@/settings";
import { OrderMonitorStorage } from "@/storage/order-monitor";

type Variables = { studioContext: StudioContext };
type C = Context<{ Variables: Variables }>;

interface Gate {
  ctx: StudioContext;
  organizationId: string;
  storage: OrderMonitorStorage;
  /** Null = the monitor is off on this deployment. */
  ingestUrl: string | null;
}

async function gate(c: C): Promise<Gate | Response> {
  const ctx = c.get("studioContext");
  if (!isAuthenticated(ctx)) return c.json({ error: "Unauthorized" }, 401);
  const org = requireOrganization(ctx);
  if (!(await orgHasFeature(ctx, org.id, "monitoring"))) {
    return c.json(
      {
        error: "This organization's plan does not include monitoring",
        code: "feature_not_in_plan",
      },
      403,
    );
  }
  const url = getSettings().orderMonitorIngestUrl;
  return {
    ctx,
    organizationId: org.id,
    storage: new OrderMonitorStorage(ctx.db),
    ingestUrl: url && isCustomerLakeConfigured() ? url : null,
  };
}

/** The store, when it is one of this org's active ingest installs. */
async function ownedStore(g: Gate, connectionId: string) {
  if (!g.ingestUrl) return null;
  const stores = await g.storage.listOrgStores(g.organizationId, g.ingestUrl);
  return stores.find((s) => s.connectionId === connectionId) ?? null;
}

/** `?at=`: any past instant, default now; the future is clamped to now. */
function parseAt(raw: string | undefined): Date | null {
  if (!raw) return new Date();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(Math.min(t, Date.now()));
}

export const createOrderMonitorRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/ingest", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    return c.json({ ingestUrl: g.ingestUrl });
  });

  app.get("/stores", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    if (!g.ingestUrl) return c.json({ stores: [] });
    const [stores, states] = await Promise.all([
      g.storage.listOrgStores(g.organizationId, g.ingestUrl),
      g.storage.listStates(g.organizationId),
    ]);
    const out: OrderMonitorStore[] = await Promise.all(
      stores.map(async (store) => {
        const info = await loadStoreInfo(
          g.ctx,
          g.storage,
          g.organizationId,
          store.connectionId,
        );
        const rules: OrderMonitorRuleState[] = states
          .filter((s) => s.connectionId === store.connectionId)
          .filter((s): s is typeof s & { rule: Rule } =>
            (RULES as readonly string[]).includes(s.rule),
          )
          .map((s) => ({
            rule: s.rule,
            status: s.status as OrderMonitorVerdict["status"],
            since: s.since.toISOString(),
            evaluatedAt: s.evaluatedAt.toISOString(),
            verdict: s.verdict as unknown as OrderMonitorVerdict,
            task: s.task,
          }));
        return {
          connectionId: store.connectionId,
          title: info?.title ?? store.title,
          agentIds: info?.agentIds ?? [],
          rules,
        };
      }),
    );
    return c.json({ stores: out });
  });

  app.get("/stores/:connectionId/day", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const connectionId = c.req.param("connectionId");
    if (!(await ownedStore(g, connectionId))) {
      return c.json({ error: "Store not found in organization" }, 404);
    }
    const at = parseAt(c.req.query("at"));
    if (!at) return c.json({ error: "at must be an ISO timestamp" }, 400);
    try {
      const day = await loadStoreDay(g.organizationId, connectionId, at, {
        approximate: true,
        channels: true,
      });
      if (!day) {
        return c.json(
          { error: "The data lake has no timezone for this store" },
          404,
        );
      }
      return c.json(buildDayView(day, at));
    } catch (err) {
      console.error("[order-monitor] day read failed", {
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to read the data lake" }, 502);
    }
  });

  // `site`: one of the org's site slugs; absent = every site the org linked.
  app.get("/traffic", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    if (!isCustomerLakeConfigured()) return c.json({ traffic: null });
    const at = parseAt(c.req.query("at"));
    if (!at) return c.json({ error: "at must be an ISO timestamp" }, 400);
    const tz = c.req.query("tz") ?? "UTC";
    if (!isTimezone(tz)) return c.json({ error: "unknown tz" }, 400);
    const site = c.req.query("site")?.toLowerCase();
    let siteId = "";
    if (site) {
      if (!(await g.ctx.storage.orgSites.isOwnedBy(site, g.organizationId))) {
        return c.json({ error: "Site not found in organization" }, 404);
      }
      const registration = await readAnalyticsRegistration(site);
      if (registration.status === "error") {
        return c.json(
          { error: "Failed to resolve analytics registration" },
          502,
        );
      }
      if (registration.status === "unregistered")
        return c.json({ traffic: null });
      siteId = registration.id;
    }
    try {
      return c.json({
        traffic: await loadSiteTraffic(g.organizationId, at, tz, siteId),
      });
    } catch (err) {
      console.error("[order-monitor] traffic read failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to read the data lake" }, 502);
    }
  });

  app.get("/stores/:connectionId/pushes", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const connectionId = c.req.param("connectionId");
    if (!(await ownedStore(g, connectionId))) {
      return c.json({ error: "Store not found in organization" }, 404);
    }
    const at = parseAt(c.req.query("at"));
    if (!at) return c.json({ error: "at must be an ISO timestamp" }, 400);
    const timezone = await loadStoreTimezone(
      g.organizationId,
      connectionId,
    ).catch(() => null);
    if (!timezone) return c.json({ repos: [] });
    const repositoryIds = await g.storage.listAgentRepositoryIds(
      g.organizationId,
      c.req.query("virtualMcpId") || undefined,
    );
    return c.json(
      await listPushes(g.ctx, g.organizationId, repositoryIds, at, timezone),
    );
  });

  return app;
};
