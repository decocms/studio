/**
 * MCP SDK does NOT throw on server-side tool errors — it returns a resolved
 * promise with `{ isError: true, ... }`. `.catch()` misses everything. Use
 * this wrapper so VM bootstrap failures don't hang the UI on "Booting…".
 */

interface MinimalMcpClient {
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
}

interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}

export async function callVmTool(
  client: MinimalMcpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as McpToolResult;
  if (result.isError) {
    const message =
      result.content?.[0]?.text ?? `Tool ${name} failed without a message`;
    throw new Error(message);
  }
  return result;
}
