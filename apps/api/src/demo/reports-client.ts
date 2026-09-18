import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";

const uri = "ui://reports/app";

/** Same tools and widget as Reports; only its data provider is replaced. */
export async function createDemoReportsClient(
  ctx: StudioContext,
  org: string,
): Promise<Client> {
  const server = new McpServer({ name: "reports", version: "1.0.0" });
  const meta = { ui: { resourceUri: uri } };
  server.registerTool(
    "get_my_diagnostic",
    {
      description: "Read the store diagnostic",
      inputSchema: { lang: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: meta,
    },
    async () => {
      const bundle = await ctx.storage.demo.bundle(org);
      const diagnostic = {
        ...bundle.diagnostic,
        org_id: org,
        public_blocked: false,
        run_in_progress: false,
        enrichment_dispatched: false,
      };
      return {
        content: [{ type: "text", text: JSON.stringify({ diagnostic }) }],
        structuredContent: { diagnostic },
        _meta: meta,
      };
    },
  );
  server.registerTool(
    "get_connection_status",
    { inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({
      content: [{ type: "text", text: "Prepared report" }],
      structuredContent: {
        connections: {
          ga4: "not_connected",
          gsc: "not_connected",
          vtex: "not_connected",
          github: "connected",
        },
        tasks_status: "pushed",
      },
    }),
  );
  server.registerTool("rerun_my_diagnostic", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "Prepared diagnostic ready" }],
    structuredContent: { rerunning: true },
  }));
  server.registerResource(
    "Reports",
    uri,
    { mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: (await ctx.storage.demo.bundle(org)).reportsHtml,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "studio-demo-reports", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
