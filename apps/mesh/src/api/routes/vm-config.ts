/**
 * Browser-facing proxy for the daemon's tenant-config endpoint.
 *
 * Mirrors vm-setup.ts: the daemon's `/_decopilot_vm/config` requires a bearer
 * token the browser doesn't hold, so this route auths the user, derives the
 * claim handle, and forwards through `runner.proxyDaemonRequest`.
 *
 * `GET`  → returns `envKeys: string[]` (the daemon never exposes values).
 * `PUT`  → forwards `{ env: { KEY: "value" | null } }` as base64 JSON, the
 *          encoding the daemon's `parseBase64JsonBody` expects.
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

export const createVmConfigRoutes = () => {
  const app = new Hono<Env>();

  app.all("/", async (c) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "PUT") {
      return c.json({ error: "Method not allowed" }, 405);
    }

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

    let body: BodyInit | null = null;
    if (method === "PUT") {
      const raw = await c.req.text();
      // Daemon expects base64-encoded JSON for /config writes.
      body = Buffer.from(raw, "utf-8").toString("base64");
    }

    let upstream: Response;
    try {
      upstream = await runner.proxyDaemonRequest(
        claimName,
        "/_decopilot_vm/config",
        {
          method,
          headers: new Headers({ "content-type": "application/json" }),
          body,
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

    const text = await upstream.text();
    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  });

  return app;
};
