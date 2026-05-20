/**
 * Browser-facing proxy for fetching resources from the sandbox preview.
 *
 * The studio UI (origin A) needs to read `.decofile` and `/live/_meta` from
 * the preview daemon (origin B). Direct client-side fetches fail due to CORS.
 * This route authenticates the user and proxies the GET request server-side,
 * following the same auth + claim + proxy pattern as `vm-file.ts`.
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

/** Allowed preview paths that can be fetched through this proxy. */
const ALLOWED_PATHS = new Set(["/.decofile", "/live/_meta"]);

async function proxyPreviewGet(c: Context<Env>) {
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
  const path = c.req.query("path");
  if (!virtualMcpId || !branch || !path) {
    return c.json(
      { error: "virtualMcpId, branch, and path are required" },
      400,
    );
  }

  if (!ALLOWED_PATHS.has(path)) {
    return c.json({ error: "Path not allowed" }, 403);
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

  const previewUrl = await runner.getPreviewUrl(claimName);
  if (!previewUrl) {
    return c.json({ error: "Preview not available" }, 502);
  }

  const base = previewUrl.replace(/\/+$/, "");
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${path}`);
  } catch {
    return c.json({ error: "Preview unreachable" }, 502);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

export const createVmPreviewFetchRoutes = () => {
  const app = new Hono<Env>();
  app.get("/", proxyPreviewGet);
  return app;
};
