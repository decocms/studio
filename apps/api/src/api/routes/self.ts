/**
 * Self MCP Server
 *
 * Exposes Studio management tools via MCP protocol at /mcp/self endpoint
 * Tools: PROJECT_CREATE, PROJECT_LIST, CONNECTION_CREATE, etc.
 */
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { StudioContext } from "../../core/studio-context";
import { managementContextStore, managementMCP } from "../../tools";
import { serveMcpRequest } from "../utils/serve-mcp";

// Define Hono variables type
type Variables = {
  studioContext: StudioContext;
};

type SelfEnv = { Variables: Variables };

export const createSelfRoutes = () => {
  const app = new Hono<SelfEnv>();

  /**
   * MCP Server endpoint for self-management tools
   *
   * Route: POST /mcp/self
   * Exposes all PROJECT_* and CONNECTION_* tools via MCP protocol
   */
  app.all("/", async (c) => {
    const ctx = c.get("studioContext");
    const server = await managementMCP(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        c.req.raw.headers.get("Accept")?.includes("application/json") ?? false,
    });
    await server.connect(transport);
    // Tool handlers read ctx from the ALS store, so the request must run inside
    // its scope.
    return managementContextStore.run(ctx, () =>
      serveMcpRequest(server, transport, c.req.raw, "mcp:self"),
    );
  });

  return app;
};
