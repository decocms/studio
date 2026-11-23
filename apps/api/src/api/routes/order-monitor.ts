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
 *   GET /admin-orgs                      → whether you may look into other orgs, and which
 *
 * `:connectionId` must be an active ingest install of the org in the path; the
 * lake read runs as that org's own user regardless.
 *
 * `?org=all|<slug>` on the reads looks into every monitored org, or one other:
 * only from an admin org (`STUDIO_ADMIN_ORG_IDS`), only for its members, the
 * same rule as the task board's analytics.
 */

import type {
  OrderMonitorRuleState,
  OrderMonitorStore,
  OrderMonitorVerdict,
} from "@decocms/shared/order-monitor";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { orgHasFeature } from "@/core/plan-feature-gate";
import {
  auditTaskBoardAdminAction,
  isAdminOrgId,
  isTaskBoardAdminCtx,
} from "@/core/task-board-admin";
import type { StudioContext } from "@/core/studio-context";
import { isAuthenticated, requireOrganization } from "@/core/studio-context";
import { analyticsAccess } from "@/analytics/access";
import { readAnalyticsRegistration } from "@/analytics/registration";
import { isCustomerLakeConfigured } from "@/customer-lake/client";
import { loadThresholds } from "@/monitoring/order-alerts";
import { loadStoreDay, loadStoreTimezone } from "@/monitoring/order-lake";
import { listPushes } from "@/monitoring/order-pushes";
import { addSiteTraffic, loadSiteTraffic } from "@/monitoring/site-traffic";
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

/** The orgs a read covers: the path org, or, for an admin org's members, `?org=`. */
interface Scope {
  orgs: { id: string; slug: string; name: string }[];
  /** Another org's data, or every org's. */
  crossOrg: boolean;
}

async function scopeOf(g: Gate, c: C): Promise<Scope | Response> {
  const own = requireOrganization(g.ctx);
  const ref = c.req.query("org");
  if (!ref || ref === own.slug || ref === own.id) {
    return {
      orgs: [{ id: own.id, slug: own.slug ?? own.id, name: own.name ?? "" }],
      crossOrg: false,
    };
  }
  if (!(await isMonitorAdmin(g))) {
    return c.json(
      { error: "Not allowed to read another organization's monitor" },
      403,
    );
  }
  if (!g.ingestUrl) return { orgs: [], crossOrg: true };
  const all = await g.storage.listMonitoredOrgs(g.ingestUrl);
  return {
    orgs: ref === "all" ? all : all.filter((o) => o.slug === ref),
    crossOrg: true,
  };
}

/** Both: the path org is an admin org, and the caller belongs to one. */
async function isMonitorAdmin(g: Gate): Promise<boolean> {
  return isAdminOrgId(g.organizationId) && (await isTaskBoardAdminCtx(g.ctx));
}

/** The org of the store, when it is an active ingest install of an org in scope. */
async function ownedStore(
  g: Gate,
  scope: Scope,
  connectionId: string,
): Promise<string | null> {
  if (!g.ingestUrl) return null;
  const orgId = await g.storage.findInstallOrg(connectionId, g.ingestUrl);
  return orgId && scope.orgs.some((o) => o.id === orgId) ? orgId : null;
}

/** The agents that aggregate the VTEX connection the install is bound to (`state.VTEX`). */
async function storeAgentIds(g: Gate, connectionId: string): Promise<string[]> {
  const install = await g.ctx.storage.connections.findById(
    connectionId,
    g.organizationId,
  );
  const binding = z
    .object({ VTEX: z.object({ value: z.string() }) })
    .safeParse(install?.configuration_state);
  if (!binding.success) return [];
  const agents = await g.storage.listAggregatingAgents(g.organizationId, [
    binding.data.VTEX.value,
  ]);
  return [...new Set(agents.map((a) => a.agentId))];
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

  app.get("/admin-orgs", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    if (!g.ingestUrl || !(await isMonitorAdmin(g))) {
      return c.json({ isAdmin: false, orgs: [] });
    }
    return c.json({
      isAdmin: true,
      orgs: await g.storage.listMonitoredOrgs(g.ingestUrl),
    });
  });

  app.get("/ingest", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    return c.json({ ingestUrl: g.ingestUrl });
  });

  app.get("/stores", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const scope = await scopeOf(g, c);
    if (scope instanceof Response) return scope;
    if (!g.ingestUrl) return c.json({ stores: [] });
    const ingestUrl = g.ingestUrl;
    if (scope.crossOrg) {
      auditTaskBoardAdminAction({
        action: "order_monitor_read",
        actorUserId: g.ctx.auth?.user?.id,
        actorOrgId: g.organizationId,
        targetOrgId: c.req.query("org"),
      });
    }
    const perOrg = await Promise.all(
      scope.orgs.map(async (org) => {
        const [stores, states] = await Promise.all([
          g.storage.listOrgStores(org.id, ingestUrl),
          g.storage.listStates(org.id),
        ]);
        return Promise.all(
          stores.map(async (store): Promise<OrderMonitorStore> => {
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
              }));
            return {
              connectionId: store.connectionId,
              // Another org's stores: named by their org, tied to none of yours.
              title: scope.crossOrg
                ? `${org.name} · ${store.title}`
                : store.title,
              agentIds: scope.crossOrg
                ? []
                : await storeAgentIds(g, store.connectionId),
              rules,
            };
          }),
        );
      }),
    );
    return c.json({ stores: perOrg.flat() });
  });

  app.get("/stores/:connectionId/day", async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const scope = await scopeOf(g, c);
    if (scope instanceof Response) return scope;
    const connectionId = c.req.param("connectionId");
    const orgId = await ownedStore(g, scope, connectionId);
    if (!orgId) {
      return c.json({ error: "Store not found in organization" }, 404);
    }
    const at = parseAt(c.req.query("at"));
    if (!at) return c.json({ error: "at must be an ISO timestamp" }, 400);
    try {
      const day = await loadStoreDay(orgId, connectionId, at, {
        approximate: true,
        channels: true,
      });
      if (!day) {
        return c.json(
          { error: "The data lake has no timezone for this store" },
          404,
        );
      }
      // The chart's bands are the thresholds the sweep judges by.
      const thresholds = await loadThresholds(g.ctx.storage.alerts, orgId);
      return c.json(buildDayView(day, at, thresholds));
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
    const scope = await scopeOf(g, c);
    if (scope instanceof Response) return scope;
    const at = parseAt(c.req.query("at"));
    if (!at) return c.json({ error: "at must be an ISO timestamp" }, 400);
    const tz = c.req.query("tz") ?? "UTC";
    if (!isTimezone(tz)) return c.json({ error: "unknown tz" }, 400);
    // Other orgs: every site each of them linked, added up.
    if (scope.crossOrg) {
      try {
        const days = await Promise.all(
          scope.orgs.map((o) => loadSiteTraffic(o.id, at, tz, "")),
        );
        return c.json({ traffic: addSiteTraffic(days) });
      } catch (err) {
        console.error("[order-monitor] traffic read failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "Failed to read the data lake" }, 502);
      }
    }
    const site = c.req.query("site")?.toLowerCase();
    let siteId = "";
    if (site) {
      const access = await analyticsAccess(g.ctx, g.organizationId, site);
      if (!access) {
        return c.json({ error: "Site not found in organization" }, 404);
      }
      if (access.kind === "error") {
        return c.json(
          { error: "Failed to resolve analytics registration" },
          502,
        );
      }
      if (access.kind === "external") {
        siteId = access.siteId;
      } else {
        const registration = await readAnalyticsRegistration(site);
        if (registration.status === "error") {
          return c.json(
            { error: "Failed to resolve analytics registration" },
            502,
          );
        }
        if (registration.status !== "registered")
          return c.json({ traffic: null });
        siteId = registration.id;
      }
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
    const scope = await scopeOf(g, c);
    if (scope instanceof Response) return scope;
    const connectionId = c.req.param("connectionId");
    if (!(await ownedStore(g, scope, connectionId))) {
      return c.json({ error: "Store not found in organization" }, 404);
    }
    // Pushes are your own repositories'; another org's store has none of them.
    if (scope.crossOrg) return c.json({ repos: [] });
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
