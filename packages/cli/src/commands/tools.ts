import { z } from "zod";
import { type CredentialOptions, resolveCredential } from "../lib/credentials";
import {
  type ConnectMcp,
  connectStreamableHttp,
  type McpToolClient,
} from "../lib/mcp";
import {
  errorMessage,
  readDataArg,
  type RequestBody,
  type RequestIo,
  type RestAuth,
  studioFetch,
  writeResponse,
} from "../lib/studio-request";
import { print } from "../lib/output";

export interface ToolsOptions extends CredentialOptions, RequestIo {
  subcommand?: string;
  /** Tool name for `describe`/`call`, or a search term for `list`. */
  arg?: string;
  org?: string;
  /** Target this agent's Virtual MCP instead of the org's builtin tools. */
  agent?: string;
  /** Tool arguments for `call`: literal JSON, `@<file>`, or `@-` for stdin. */
  data?: string;
  /** `list` prints the full tool objects instead of one line per tool. */
  json?: boolean;
  /** Injectable for tests. Defaults to an MCP Streamable HTTP client. */
  connectMcp?: ConnectMcp;
}

const TOOLS_USAGE = `Usage:
  decocms tools list [search] [--org <slug>] [--agent <id>] [--json]
  decocms tools describe <name> [--org <slug>] [--agent <id>]
  decocms tools call <name> [--org <slug>] [--agent <id>] [-d <json|@file|@->]

Inside a Studio run, tools come from the run's endpoint and need no flags.`;

const ToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
});
type Tool = z.infer<typeof ToolSchema>;

const ToolListSchema = z.object({ tools: z.array(ToolSchema) });

const ArgumentsSchema = z.record(z.string(), z.unknown());

/** Where `tools` reads and calls tools. */
interface ToolSource {
  /** The tool list, or an exit code after the failure was reported. */
  list(): Promise<Tool[] | number>;
  call(name: string, body: RequestBody): Promise<number>;
  close(): Promise<void>;
}

/**
 * `decocms tools` — list, describe, and call tools. With a login or
 * `STUDIO_API_KEY` they are the org's builtin tools (`/api/:org/tools`), or an
 * agent's with `--agent`; inside a Studio run, the run's own tools.
 */
export async function toolsCommand(options: ToolsOptions): Promise<number> {
  const { subcommand, arg } = options;
  if (
    !subcommand ||
    !["list", "describe", "call"].includes(subcommand) ||
    (subcommand !== "list" && !arg)
  ) {
    console.error(TOOLS_USAGE);
    return 1;
  }

  const source = await openSource(options);
  if (typeof source === "number") return source;
  try {
    if (subcommand === "call" && arg) {
      let body: RequestBody;
      try {
        body = (await readDataArg(options.data, options.readStdin)) ?? {
          bytes: "{}",
          contentType: "application/json",
        };
      } catch (err) {
        console.error(errorMessage(err));
        return 1;
      }
      return await source.call(arg, body);
    }

    const tools = await source.list();
    if (typeof tools === "number") return tools;

    if (subcommand === "describe") {
      const tool = tools.find((t) => t.name === arg);
      if (!tool) {
        console.error(
          `Unknown tool: ${arg}. Search with \`decocms tools list\`.`,
        );
        return 1;
      }
      print(JSON.stringify(tool, null, 2));
      return 0;
    }

    const term = arg?.toLowerCase();
    const matches = term
      ? tools.filter(
          (t) =>
            t.name.toLowerCase().includes(term) ||
            t.description?.toLowerCase().includes(term),
        )
      : tools;
    if (options.json) {
      print(JSON.stringify(matches));
      return 0;
    }
    for (const tool of matches) {
      const summary = tool.description?.trim().split("\n")[0] ?? "";
      print(summary ? `${tool.name}\t${summary}` : tool.name);
    }
    return 0;
  } finally {
    await source.close();
  }
}

async function openSource(options: ToolsOptions): Promise<ToolSource | number> {
  const credential = await resolveCredential(options);
  if (!credential) return 1;
  const connect = options.connectMcp ?? connectStreamableHttp;

  if (credential.kind === "run") {
    if (options.agent) {
      console.error(
        "--agent is not available inside a Studio run; the run's endpoint decides its tools.",
      );
      return 1;
    }
    return mcpSource(() =>
      connect(new URL(credential.url), credential.headers),
    );
  }

  if (!options.org) {
    console.error(
      "Missing --org <slug>. Run `decocms orgs` to list your organizations.",
    );
    return 1;
  }
  const org = encodeURIComponent(options.org);
  if (options.agent) {
    const url = new URL(
      `/api/${org}/mcp/virtual-mcp/${encodeURIComponent(options.agent)}`,
      credential.target,
    );
    return mcpSource(() =>
      connect(url, { Authorization: `Bearer ${credential.token}` }),
    );
  }
  return restSource(credential, `/api/${org}/tools`, options);
}

function restSource(
  auth: RestAuth,
  base: string,
  options: ToolsOptions,
): ToolSource {
  return {
    async list() {
      const res = await studioFetch(auth, base, {
        method: "GET",
        fetch: options.fetch,
      });
      if (!res.ok) return writeResponse(res, auth, options.output);
      const parsed = ToolListSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.error("Unexpected response from the tools endpoint.");
        return 1;
      }
      return parsed.data.tools;
    },
    async call(name, body) {
      const res = await studioFetch(
        auth,
        `${base}/${encodeURIComponent(name)}`,
        {
          method: "POST",
          body,
          fetch: options.fetch,
        },
      );
      return writeResponse(res, auth, options.output);
    },
    async close() {},
  };
}

function mcpSource(open: () => Promise<McpToolClient>): ToolSource {
  let client: Promise<McpToolClient> | undefined;
  const connected = () => {
    client ??= open();
    return client;
  };
  return {
    async list() {
      try {
        const { tools } = await (await connected()).listTools();
        const parsed = z.array(ToolSchema).safeParse(tools);
        if (!parsed.success) {
          console.error("Unexpected tool list from the MCP endpoint.");
          return 1;
        }
        return parsed.data;
      } catch (err) {
        console.error(errorMessage(err));
        return 1;
      }
    },
    async call(name, body) {
      const text =
        typeof body.bytes === "string"
          ? body.bytes
          : new TextDecoder().decode(body.bytes);
      let args: Record<string, unknown>;
      try {
        args = ArgumentsSchema.parse(JSON.parse(text));
      } catch {
        console.error("Tool arguments must be a JSON object.");
        return 1;
      }
      try {
        const result = await (await connected()).callTool({
          name,
          arguments: args,
        });
        return printCallResult(result);
      } catch (err) {
        console.error(errorMessage(err));
        return 1;
      }
    },
    async close() {
      if (client) await (await client).close().catch(() => {});
    },
  };
}

const CallResultSchema = z.looseObject({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    .optional(),
});

/**
 * Prints what REST dispatch would have returned: the structured result, else
 * a JSON text block parsed, else the raw content. Errors exit 1.
 */
function printCallResult(result: unknown): number {
  const parsed = CallResultSchema.safeParse(result);
  if (!parsed.success) {
    print(JSON.stringify(result));
    return 0;
  }
  const { isError, structuredContent, content } = parsed.data;
  const onlyText =
    content?.length === 1 && content[0]?.type === "text"
      ? content[0].text
      : undefined;
  let value: unknown = structuredContent ?? content ?? null;
  if (structuredContent === undefined && onlyText !== undefined) {
    try {
      value = JSON.parse(onlyText);
    } catch {
      value = onlyText;
    }
  }
  if (isError) console.error("The tool returned an error.");
  print(JSON.stringify(value));
  return isError ? 1 : 0;
}
