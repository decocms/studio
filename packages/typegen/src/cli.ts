#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { generateClientCode } from "./codegen.js";

const DEFAULT_BASE_URL = "https://studio.decocms.com";

function parseArgs(argv: string[]): {
  mcpId: string;
  apiKey: string | undefined;
  baseUrl: string;
  output: string;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const mcpId = get("--mcp");
  if (!mcpId) {
    console.error("Error: --mcp <virtual-mcp-id> is required");
    process.exit(1);
  }

  return {
    mcpId,
    apiKey: get("--key") ?? process.env.MESH_API_KEY,
    baseUrl: get("--url") ?? process.env.MESH_BASE_URL ?? DEFAULT_BASE_URL,
    output: get("--output") ?? "client.ts",
  };
}

async function main() {
  const { mcpId, apiKey, baseUrl, output } = parseArgs(process.argv);

  console.log(`Connecting to Virtual MCP: ${mcpId}`);

  const url = new URL(`/mcp/virtual-mcp/${mcpId}`, baseUrl);
  const client = new Client({ name: "@decocms/typegen", version: "1.0.0" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        },
      }),
    );
  } catch (err) {
    console.error(
      `Error: Failed to connect to ${url}\n${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const { tools } = await client.listTools();

  console.log(
    `Found ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ") || "(none)"}`,
  );

  const code = await generateClientCode({
    mcpId,
    tools: tools.map((t) => ({
      name: t.name,
      inputSchema: t.inputSchema as object,
      outputSchema: (t as { outputSchema?: object }).outputSchema,
    })),
  });

  await writeFile(output, code, "utf-8");
  console.log(`Generated: ${output}`);

  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
