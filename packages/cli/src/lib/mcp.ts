import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The slice of the MCP client the commands use. */
export interface McpToolClient {
  listTools(): Promise<{ tools: unknown[] }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export type ConnectMcp = (
  url: URL,
  headers: Record<string, string>,
) => Promise<McpToolClient>;

export const connectStreamableHttp: ConnectMcp = async (url, headers) => {
  const client = new Client({ name: "decocms", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
  );
  return client;
};
