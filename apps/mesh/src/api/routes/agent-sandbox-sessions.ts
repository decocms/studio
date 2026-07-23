import { Hono } from "hono";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getSettings } from "../../settings";
import type { Env } from "../hono-env";

interface SessionCursor {
  updatedAt: string;
  branch: string;
}

function decodeCursor(value: string | undefined): SessionCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SessionCursor>;
    if (
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.branch !== "string" ||
      !parsed.branch
    ) {
      return undefined;
    }
    return { updatedAt: parsed.updatedAt, branch: parsed.branch };
  } catch {
    return undefined;
  }
}

function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function createAgentSandboxSessionRoutes() {
  const app = new Hono<Env>();

  app.get("/:virtualMcpId", async (c) => {
    const ctx = c.var.studioContext;
    try {
      requireAuth(ctx);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const organization = requireOrganization(ctx);
    const virtualMcpId = c.req.param("virtualMcpId");
    const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      return c.json({ error: "Virtual MCP not found" }, 404);
    }

    if (!getSettings().sharedAgentSandboxesEnabled) {
      return c.json({ items: [], nextCursor: null });
    }

    const branch = c.req.query("branch");
    if (branch) {
      const session = await ctx.storage.agentSandboxSessions.find({
        organizationId: organization.id,
        virtualMcpId,
        branch,
      });
      return c.json({ items: session ? [session] : [], nextCursor: null });
    }

    const requestedLimit = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 100;
    const rawBefore = c.req.query("before");
    const before = decodeCursor(rawBefore);
    if (rawBefore && !before) {
      return c.json({ error: "Invalid pagination cursor" }, 400);
    }
    const items = await ctx.storage.agentSandboxSessions.listByVirtualMcp(
      organization.id,
      virtualMcpId,
      {
        limit: limit + 1,
        before,
      },
    );
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return c.json({
      items: page,
      nextCursor:
        hasMore && page.at(-1)
          ? encodeCursor({
              updatedAt: page.at(-1)!.updatedAt,
              branch: page.at(-1)!.branch,
            })
          : null,
    });
  });

  return app;
}
