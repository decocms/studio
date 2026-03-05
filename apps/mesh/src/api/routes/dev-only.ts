/**
 * Dev-Only Routes Module
 *
 * This module contains all dev-only routes and handlers that should NEVER
 * be loaded in production. It consolidates:
 * - Dev Assets MCP (local filesystem object storage)
 * - Dev Assets file serving (presigned URL handlers)
 * - Connection ID pattern routing for dev-assets
 *
 * USAGE (in app.ts):
 * ```
 * if (process.env.NODE_ENV !== "production") {
 *   const { mountDevRoutes } = await import("./routes/dev-only");
 *   mountDevRoutes(app, mcpAuth);
 * }
 * ```
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import devAssetsMcpRoutes, {
  callDevAssetsTool,
  handleDevAssetsMcpRequest,
} from "./dev-assets-mcp";
import devAssetsFileRoutes from "./dev-assets";

/**
 * Mount all dev-only routes on the app
 *
 * This is the ONLY export that should be used from app.ts.
 * All other functionality is encapsulated within this module.
 */
export function mountDevRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpAuth: MiddlewareHandler<any>,
) {
  // Handle {org_id}_dev-assets connection ID pattern -> forward to dev-assets MCP
  // This allows the frontend to use the connection ID while routing to the dev MCP
  app.all(
    "/mcp/:connectionId{.*_dev-assets$}",
    mcpAuth,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c: Context<any>) => {
      const ctx = c.get("meshContext") as MeshContext;
      const url = new URL(c.req.url);
      const baseUrl = `${url.protocol}//${url.host}`;
      return handleDevAssetsMcpRequest(c.req.raw, ctx, baseUrl);
    },
  );

  // Handle call-tool endpoint for dev-assets connections
  app.all(
    "/mcp/:connectionId{.*_dev-assets$}/call-tool/:toolName",
    mcpAuth,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c: Context<any>) => {
      const ctx = c.get("meshContext") as MeshContext;
      const url = new URL(c.req.url);
      const baseUrl = `${url.protocol}//${url.host}`;
      const toolName = c.req.param("toolName");
      if (!toolName) {
        return c.json({ error: "Missing tool name" }, 400);
      }
      const args = (await c.req.json()) as Record<string, unknown>;

      const result = await callDevAssetsTool(toolName, args, ctx, baseUrl);

      if (result.isError) {
        return c.json(result.content, 500);
      }

      return c.json(result.content);
    },
  );

  // Dev Assets MCP requires authentication
  app.use("/mcp/dev-assets", mcpAuth);
  app.route("/mcp/dev-assets", devAssetsMcpRoutes);

  // Dev Assets file serving routes (presigned URL handlers)
  // These are public but use signed URLs for security
  app.route("/api/dev-assets", devAssetsFileRoutes);
}
