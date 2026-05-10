/**
 * Browser-facing retry proxy for the daemon's setup pipeline.
 *
 * The daemon exposes `POST /_decopilot_vm/setup/{clone,install,start}` to
 * resume the setup pipeline from a named step. Like the other mutating
 * `/_decopilot_vm/*` routes, those require `Authorization: Bearer
 * <DAEMON_TOKEN>`, which the browser doesn't hold — so retry buttons in the
 * env panel route through here. We authenticate the user, derive their claim
 * handle the same way `vm-events.ts` does, and forward through
 * `runner.proxyDaemonRequest`, which injects the bearer inside the runner.
 */

import { Hono } from "hono";
import { composeSandboxRef } from "@decocms/sandbox/runner";
import { computeClaimHandle } from "../../sandbox/claim-handle";
import { getOrInitSharedRunner } from "../../sandbox/lifecycle";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import type { Env } from "../hono-env";

const SETUP_STEPS = ["clone", "install", "start"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

function isSetupStep(value: string): value is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(value);
}

export const createVmSetupRoutes = () => {
  const app = new Hono<Env>();

  app.post("/:step", async (c) => {
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

    const step = c.req.param("step");
    if (!step || !isSetupStep(step)) {
      return c.json(
        {
          error: `step must be one of: ${SETUP_STEPS.join(", ")}`,
        },
        400,
      );
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
      upstream = await runner.proxyDaemonRequest(
        claimName,
        `/_decopilot_vm/setup/${step}`,
        {
          method: "POST",
          headers: new Headers(),
          body: null,
          signal: c.req.raw.signal,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Daemon unreachable: ${message}` }, 502);
    }

    if (upstream.status === 404) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      return c.json(
        {
          error:
            "Sandbox handle is gone. The sandbox needs to be re-provisioned.",
        },
        410,
      );
    }

    const body = await upstream.text();
    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    return new Response(body, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  });

  return app;
};
