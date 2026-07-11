/**
 * Materializes an org's Virtual MCP tool catalog onto the sandbox filesystem so
 * an agent can discover and script against tools from disk (see the typegen CLI
 * / generated client). Writes one raw JSON Schema file per tool under
 * `<repo>/.deco/tools/`. Deliberately keeps only JSON Schema — no TypeScript
 * codegen — so it pulls no prettier / json-schema-to-typescript into the daemon
 * bundle. Agents wanting the typed client run `@decocms/typegen` themselves.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { safePath } from "./paths";

/** Where the catalog lands, relative to the repo root. */
export const CATALOG_DIR = ".deco/tools";

export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
}

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface CatalogFile {
  filename: string;
  content: string;
}

/**
 * One JSON Schema file per tool: `<TOOL>.json` holding
 * `{ name, description?, inputSchema, outputSchema? }`. Pure — the caller writes
 * them. Filenames are sanitized to filesystem-safe chars while the original
 * tool name is preserved inside the file.
 */
export function toolCatalogFiles(tools: CatalogTool[]): CatalogFile[] {
  return tools.map((tool) => {
    const body: Record<string, unknown> = { name: tool.name };
    if (tool.description) body.description = tool.description;
    body.inputSchema = tool.inputSchema ?? { type: "object" };
    if (tool.outputSchema) body.outputSchema = tool.outputSchema;
    return {
      filename: `${tool.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`,
      content: `${JSON.stringify(body, null, 2)}\n`,
    };
  });
}

/** Connect to a Virtual MCP endpoint and list its tools. */
export async function fetchToolCatalog(
  mcp: McpEndpoint,
): Promise<CatalogTool[]> {
  const client = new Client({
    name: "@decocms/sandbox-tools-catalog",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: mcp.headers },
    }),
  );
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: (t as { outputSchema?: unknown }).outputSchema,
    }));
  } finally {
    await client.close();
  }
}

/**
 * Fetch the catalog and write it under `<repoDir>/.deco/tools/`, clamped to
 * `appRoot`. Returns the tool names written.
 */
export async function syncToolCatalog(
  mcp: McpEndpoint,
  opts: { appRoot: string; repoDir: string },
): Promise<{ count: number; tools: string[] }> {
  const tools = await fetchToolCatalog(mcp);
  const files = toolCatalogFiles(tools);
  // Async fs: this can fire during dispatch, and the daemon runs a single
  // event loop — sync writes would stall it. Writes run concurrently.
  const written = await Promise.all(
    files.map(async (file, i) => {
      const target = safePath(
        opts.appRoot,
        opts.repoDir,
        `${CATALOG_DIR}/${file.filename}`,
      );
      if (!target) return null; // escapes the workspace root — skip
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf-8");
      return tools[i].name;
    }),
  );
  const names = written.filter((n): n is string => n !== null);
  return { count: names.length, tools: names };
}
