import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { generateClientCode, toolSchemaFiles } from "../lib/codegen";
import { type CredentialOptions, resolveCredential } from "../lib/credentials";
import { mcpIdFromUrl } from "../lib/endpoint";
import { type ConnectMcp, connectStreamableHttp } from "../lib/mcp";
import { errorMessage } from "../lib/studio-request";

export interface TypegenOptions extends CredentialOptions {
  org?: string;
  /** The agent (Virtual MCP) to generate a client for. */
  agent?: string;
  /** Generated module path. Defaults to `client.ts`. */
  output?: string;
  /** Also write one JSON Schema file per tool here. */
  schemasDir?: string;
  /** Injectable for tests. Defaults to an MCP Streamable HTTP client. */
  connectMcp?: ConnectMcp;
}

const TYPEGEN_USAGE = `Usage:
  decocms typegen --org <slug> --agent <id> [--output client.ts] [--schemas-dir <dir>]

Inside a Studio run, the run's agent is the default and no flags are needed.`;

const ToolDefinitionSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.looseObject({}),
  outputSchema: z.looseObject({}).optional(),
});

/**
 * `decocms typegen` — write a typed TypeScript client for an agent's tools,
 * built on `createStudioClient` from `@decocms/typegen`.
 */
export async function typegenCommand(options: TypegenOptions): Promise<number> {
  const credential = await resolveCredential(options);
  if (!credential) return 1;

  let url: URL;
  let headers: Record<string, string>;
  let mcpId: string | undefined;
  if (credential.kind === "run") {
    if (options.agent) {
      console.error(
        "--agent is not available inside a Studio run; the client is generated for the run's agent.",
      );
      return 1;
    }
    url = new URL(credential.url);
    headers = credential.headers;
    mcpId = mcpIdFromUrl(credential.url);
    if (!mcpId) {
      console.error(
        `Could not read the agent id from the run's endpoint (${credential.url}).`,
      );
      return 1;
    }
  } else {
    if (!options.org || !options.agent) {
      console.error(TYPEGEN_USAGE);
      return 1;
    }
    url = new URL(
      `/api/${encodeURIComponent(options.org)}/mcp/virtual-mcp/${encodeURIComponent(options.agent)}`,
      credential.target,
    );
    headers = { Authorization: `Bearer ${credential.token}` };
    mcpId = options.agent;
  }

  let tools: z.infer<typeof ToolDefinitionSchema>[];
  try {
    const client = await (options.connectMcp ?? connectStreamableHttp)(
      url,
      headers,
    );
    try {
      const listed = z
        .array(ToolDefinitionSchema)
        .safeParse((await client.listTools()).tools);
      if (!listed.success) {
        console.error("Unexpected tool list from the MCP endpoint.");
        return 1;
      }
      tools = listed.data;
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  const output = options.output ?? "client.ts";
  await writeFile(output, await generateClientCode({ mcpId, tools }), "utf-8");
  console.log(`Generated ${output} with ${tools.length} tool(s) for ${mcpId}.`);

  if (options.schemasDir) {
    const schemasDir = options.schemasDir;
    await mkdir(schemasDir, { recursive: true });
    const files = toolSchemaFiles(tools);
    await Promise.all(
      files.map((file) =>
        writeFile(join(schemasDir, file.filename), file.content),
      ),
    );
    console.log(`Wrote ${files.length} schema file(s) to ${schemasDir}.`);
  }
  return 0;
}
