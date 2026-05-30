/**
 * Self MCP Server
 *
 * Exposes MCP Mesh management tools via MCP protocol at /mcp/self endpoint
 * Tools: PROJECT_CREATE, PROJECT_LIST, CONNECTION_CREATE, etc.
 */
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { MeshContext } from "../../core/mesh-context";
import { managementMCP } from "../../tools";

// Define Hono variables type
type Variables = {
  meshContext: MeshContext;
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
    const server = await managementMCP(c.get("meshContext"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse:
        c.req.raw.headers.get("Accept")?.includes("application/json") ?? false,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
};
