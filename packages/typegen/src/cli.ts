#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { generateClientCode, toolSchemaFiles } from "./codegen.js";
import { discoverEndpoint, mcpIdFromUrl } from "./endpoint.js";
import { createStudioClient } from "./runtime.js";

const DEFAULT_BASE_URL = "https://studio.decocms.com";

interface Common {
  /** From --mcp/env, or parsed from a discovered endpoint URL. */
  mcpId: string | undefined;
  url: URL;
  headers: Record<string, string>;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Args that are neither a `--flag` nor a flag's value. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++; // skip the flag's value
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** Resolve where every command connects. Flags, then STUDIO_* (or legacy
 *  MESH_*) env vars, then — with no id at all — the sandbox endpoint file
 *  (`.deco/tools/.endpoint.json`, written by the daemon), so the CLI runs
 *  fully flagless inside a sandbox workspace. */
function common(args: string[]): Common {
  const mcpId =
    flag(args, "--mcp") ?? process.env.STUDIO_MCP_ID ?? process.env.MESH_MCP_ID;
  if (mcpId) {
    const apiKey =
      flag(args, "--key") ??
      process.env.STUDIO_API_KEY ??
      process.env.MESH_API_KEY;
    const base = (
      flag(args, "--url") ??
      process.env.STUDIO_BASE_URL ??
      process.env.MESH_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "");
    return {
      mcpId,
      // String concat (not `new URL(path, base)`) so a path-prefixed base
      // URL is preserved; encode the id against special characters.
      url: new URL(`${base}/mcp/virtual-mcp/${encodeURIComponent(mcpId)}`),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    };
  }
  const discovered = discoverEndpoint();
  if (!discovered) {
    console.error(
      "Error: --mcp <virtual-mcp-id> is required (or set STUDIO_MCP_ID, or run inside a sandbox workspace with .deco/tools/.endpoint.json)",
    );
    process.exit(1);
  }
  return {
    mcpId: mcpIdFromUrl(discovered.url),
    url: new URL(discovered.url),
    headers: discovered.headers ?? {},
  };
}

async function connect({ url, headers }: Common): Promise<Client> {
  const client = new Client({ name: "@decocms/typegen", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    );
  } catch (err) {
    console.error(
      `Error: Failed to connect to ${url}\n${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  return client;
}

async function cmdGenerate(args: string[]): Promise<void> {
  const opts = common(args);
  const output = flag(args, "--output") ?? "client.ts";
  const schemasDir = flag(args, "--schemas-dir");
  if (!opts.mcpId) {
    // Discovered endpoint without the /mcp/virtual-mcp/<id> shape — codegen
    // embeds the id in the client, so it must be explicit here.
    console.error(
      "Error: could not derive the Virtual MCP id from the discovered endpoint — pass --mcp <virtual-mcp-id>",
    );
    process.exit(1);
  }

  console.log(`Connecting to Virtual MCP: ${opts.mcpId}`);
  const client = await connect(opts);
  const { tools } = await client.listTools();
  console.log(
    `Found ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ") || "(none)"}`,
  );

  const defs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as object,
    outputSchema: (t as { outputSchema?: object }).outputSchema,
  }));

  const code = await generateClientCode({ mcpId: opts.mcpId, tools: defs });
  await writeFile(output, code, "utf-8");
  console.log(`Generated: ${output}`);

  if (schemasDir) {
    await mkdir(schemasDir, { recursive: true });
    const files = toolSchemaFiles(defs);
    await Promise.all(
      files.map((f) => writeFile(join(schemasDir, f.filename), f.content)),
    );
    console.log(`Wrote ${files.length} schema file(s) to: ${schemasDir}`);
  }

  await client.close();
}

async function cmdTools(args: string[]): Promise<void> {
  const opts = common(args);
  const name = positionals(args)[1]; // [0] is "tools"
  const client = await connect(opts);
  const { tools } = await client.listTools();
  await client.close();

  if (name) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      console.error(`Error: tool "${name}" not found`);
      process.exit(1);
    }
    console.log(JSON.stringify(tool, null, 2));
    return;
  }

  for (const t of tools) {
    const desc = t.description ? ` — ${t.description.split("\n")[0]}` : "";
    console.log(`${t.name}${desc}`);
  }
}

async function cmdCall(args: string[]): Promise<void> {
  const opts = common(args);
  const [, name, inputArg] = positionals(args); // [0] is "call"
  if (!name) {
    console.error("Error: usage: typegen call <TOOL_NAME> '<json-input>'");
    process.exit(1);
  }
  let input: unknown = {};
  if (inputArg) {
    try {
      input = JSON.parse(inputArg);
    } catch {
      console.error("Error: input must be valid JSON");
      process.exit(1);
    }
  }

  const client = createStudioClient({
    endpoint: { url: opts.url.toString(), headers: opts.headers },
  }) as Record<string, (i: unknown) => Promise<unknown>> & {
    close: () => Promise<void>;
  };

  try {
    const result = await client[name](input);
    console.log(JSON.stringify(result ?? null, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "tools") return cmdTools(args);
  if (cmd === "call") return cmdCall(args);
  // Default (no subcommand, or leading `--mcp ...`): generate a client.
  return cmdGenerate(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
