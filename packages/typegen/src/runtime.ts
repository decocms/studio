import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MeshClientInstance, MeshClientOptions, ToolMap } from "./index.js";

const DEFAULT_BASE_URL = "https://mesh-admin.decocms.com";

export function createMeshClient<T extends ToolMap>(
  opts: MeshClientOptions,
): MeshClientInstance<T> {
  let mcpClient: Client | null = null;

  async function getClient(): Promise<Client> {
    if (mcpClient) return mcpClient;

    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const apiKey = opts.apiKey ?? process.env.MESH_API_KEY;
    const url = new URL(`/mcp/virtual-mcp/${opts.mcpId}`, baseUrl);

    const client = new Client({ name: "@decocms/typegen", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        },
      }),
    );

    mcpClient = client;
    return client;
  }

  return new Proxy({} as MeshClientInstance<T>, {
    get(_target, toolName: string) {
      return async (input: unknown) => {
        const client = await getClient();
        const result = await client.callTool({
          name: toolName,
          arguments: input as Record<string, unknown>,
        });

        if (result.isError) {
          const message = Array.isArray(result.content)
            ? result.content.map((c) => ("text" in c ? c.text : "")).join(" ")
            : "Tool call failed";
          throw new Error(message);
        }

        return result.structuredContent;
      };
    },
  });
}
