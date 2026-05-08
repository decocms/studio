/**
 * Browser-facing `/exec` and `/kill` proxy.
 *
 * The daemon enforces `Authorization: Bearer <DAEMON_TOKEN>` on every mutating
 * `/_decopilot_vm/*` route. The browser doesn't (and shouldn't) hold that
 * token, so the env panel routes script start/stop here. We authenticate the
 * user, derive their claim handle the same way `vm-events.ts` does, and
 * forward through `runner.proxyDaemonRequest`, which injects the bearer
 * inside the runner.
 */

import { Hono, type Context } from "hono";
import { composeSandboxRef } from "@decocms/sandbox/runner";
import { computeClaimHandle } from "../../sandbox/claim-handle";
import { getOrInitSharedRunner } from "../../sandbox/lifecycle";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import type { Env } from "../hono-env";

async function proxy(c: Context<Env>, daemonPath: string) {
  const ctx = c.var.meshContext;
  try {
    requireAuth(ctx);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const userId = getUserId(ctx);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  let organization: ReturnType<typeof requireOrganization>;
  try {
    organization = requireOrganization(ctx);
  } catch {
    return c.json({ error: "Organization scope required" }, 403);
  }

  const virtualMcpId = c.req.query("virtualMcpId");
  const branch = c.req.query("branch");
  if (!virtualMcpId || !branch) {
    return c.json({ error: "virtualMcpId and branch are required" }, 400);
  }

  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }

  const projectRef = composeSandboxRef({
    orgId: organization.id,
    virtualMcpId,
    branch,
  });
  const claimName = computeClaimHandle({ userId, projectRef }, branch);

  const runner = await getOrInitSharedRunner();
  if (!runner) {
    return c.json({ error: "No sandbox runner configured" }, 503);
  }

  let upstream: Response;
  try {
    upstream = await runner.proxyDaemonRequest(claimName, daemonPath, {
      method: "POST",
      headers: new Headers(),
      body: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Daemon unreachable: ${message}` }, 502);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}

export const createVmExecRoutes = () => {
  const app = new Hono<Env>();

  app.post("/exec/:script", (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxy(c, `/_decopilot_vm/exec/${encodeURIComponent(script)}`);
  });

  app.post("/kill/:script", (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxy(c, `/_decopilot_vm/exec/${encodeURIComponent(script)}/kill`);
  });

  return app;
};
