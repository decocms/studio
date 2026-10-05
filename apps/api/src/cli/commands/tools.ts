import { z } from "zod";
import {
  errorMessage,
  readDataArg,
  type RequestIo,
  requireSession,
  type SessionOptions,
  studioFetch,
  writeResponse,
} from "../lib/studio-request";

export interface ToolsOptions extends SessionOptions, RequestIo {
  subcommand?: string;
  /** Tool name for `describe`/`call`, or a search term for `list`. */
  arg?: string;
  org?: string;
  /** Tool arguments for `call`: literal JSON, `@<file>`, or `@-` for stdin. */
  data?: string;
  /** `list` prints the full tool objects instead of one line per tool. */
  json?: boolean;
}

const TOOLS_USAGE = `Usage:
  decocms tools list --org <slug> [search] [--json]
  decocms tools describe <name> --org <slug>
  decocms tools call <name> --org <slug> [-d <json|@file|@->]`;

const ToolListSchema = z.object({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
});

/**
 * `decocms tools` — list, describe, and call the studio's builtin tools
 * through the REST dispatch at `/api/:org/tools`.
 */
export async function toolsCommand(options: ToolsOptions): Promise<number> {
  const { subcommand, arg, org } = options;
  if (
    !subcommand ||
    !["list", "describe", "call"].includes(subcommand) ||
    (subcommand !== "list" && !arg)
  ) {
    console.error(TOOLS_USAGE);
    return 1;
  }
  if (!org) {
    console.error(
      "Missing --org <slug>. The slug is the first path segment of the studio URL.",
    );
    return 1;
  }

  const session = await requireSession(options);
  if (!session) return 1;

  const base = `/api/${encodeURIComponent(org)}/tools`;

  if (subcommand === "call" && arg) {
    let res: Response;
    try {
      const body = (await readDataArg(options.data, options.readStdin)) ?? {
        bytes: "{}",
        contentType: "application/json",
      };
      res = await studioFetch(session, `${base}/${encodeURIComponent(arg)}`, {
        method: "POST",
        body,
        fetch: options.fetch,
      });
    } catch (err) {
      console.error(errorMessage(err));
      return 1;
    }
    return writeResponse(res, session, options.output);
  }

  const res = await studioFetch(session, base, {
    method: "GET",
    fetch: options.fetch,
  });
  if (!res.ok) return writeResponse(res, session, options.output);
  const parsed = ToolListSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.error("Unexpected response from the tools endpoint.");
    return 1;
  }
  const { tools } = parsed.data;

  if (subcommand === "describe") {
    const tool = tools.find((t) => t.name === arg);
    if (!tool) {
      console.error(
        `Unknown tool: ${arg}. Run \`decocms tools list --org ${org} <search>\`.`,
      );
      return 1;
    }
    console.log(JSON.stringify(tool, null, 2));
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
    console.log(JSON.stringify(matches));
    return 0;
  }
  for (const tool of matches) {
    const summary = tool.description?.trim().split("\n")[0] ?? "";
    console.log(summary ? `${tool.name}\t${summary}` : tool.name);
  }
  return 0;
}
