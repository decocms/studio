import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** Top-level commands this package owns. */
export const STUDIO_CLI_COMMANDS = [
  "auth",
  "api",
  "tools",
  "orgs",
  "typegen",
] as const;

export function isStudioCliCommand(command: string | undefined): boolean {
  return STUDIO_CLI_COMMANDS.some((name) => name === command);
}

export const STUDIO_CLI_USAGE = `Studio commands:
  decocms auth <login|whoami|token|logout>   Manage your Studio login
  decocms orgs                               List the organizations you belong to
  decocms tools <list|describe|call>         List, inspect, and call tools
  decocms api <path>                         Authenticated request to any Studio route
  decocms typegen                            Generate a typed TypeScript client for an agent's tools

Credentials, first match wins:
  --target <url>        Your login for that studio (also picks the studio for auth login)
  STUDIO_API_KEY        API key, with STUDIO_BASE_URL (default: https://studio.decocms.com)
  .deco/tools/.endpoint.json   Inside a Studio run: the run's own credential
  decocms auth login    Your login (default studio: https://studio.decocms.com)

Options:
  --org <slug>          Organization for tools (not needed inside a run)
  --agent <id>          tools: use this agent's tools instead of the org's builtin tools;
                        typegen: the agent to generate a client for
  -X, --method <m>      api: HTTP method (default: POST with --data, else GET)
  -d, --data <body>     Request body or tool arguments: literal, @<file>, or @- for stdin
  -H, --header <h>      api: extra header "Name: value" (repeatable)
  --json                tools list / orgs: print full objects
  --output <file>       typegen: generated module (default: client.ts)
  --schemas-dir <dir>   typegen: also write one JSON Schema file per tool
  --home <path>         Where the login is stored (default: ~/deco, or DATA_DIR / DECOCMS_HOME)`;

/**
 * Runs `auth`, `api`, `tools`, or `orgs` with `args` (the command first) and
 * returns the exit code.
 */
export async function runStudioCli(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(STUDIO_CLI_USAGE);
    return 0;
  }
  const dataDir =
    values.home ??
    process.env.DATA_DIR ??
    process.env.DECOCMS_HOME ??
    join(homedir(), "deco");
  const common = { dataDir, target: values.target };
  const [command, sub, arg] = positionals;

  switch (command) {
    case "auth": {
      if (sub === "login") {
        const { loginCommand } = await import("./commands/auth/login");
        return loginCommand(common);
      }
      if (sub === "whoami") {
        const { whoamiCommand } = await import("./commands/auth/whoami");
        return whoamiCommand(common);
      }
      if (sub === "token") {
        const { tokenCommand } = await import("./commands/auth/token");
        return tokenCommand(common);
      }
      if (sub === "logout") {
        const { logoutCommand } = await import("./commands/auth/logout");
        return logoutCommand(common);
      }
      console.error("Usage: decocms auth <login|whoami|token|logout>");
      return 1;
    }
    case "api": {
      const { apiCommand } = await import("./commands/api");
      return apiCommand({
        ...common,
        path: sub,
        method: values.method,
        data: values.data,
        headers: values.header,
      });
    }
    case "tools": {
      const { toolsCommand } = await import("./commands/tools");
      return toolsCommand({
        ...common,
        subcommand: sub,
        arg,
        org: values.org,
        agent: values.agent,
        data: values.data,
        json: values.json,
      });
    }
    case "typegen": {
      const { typegenCommand } = await import("./commands/typegen");
      return typegenCommand({
        ...common,
        org: values.org,
        agent: values.agent,
        output: values.output,
        schemasDir: values["schemas-dir"],
      });
    }
    case "orgs": {
      const { orgsCommand } = await import("./commands/orgs");
      return orgsCommand({ ...common, json: values.json });
    }
    default:
      console.error(STUDIO_CLI_USAGE);
      return 1;
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      target: { type: "string" },
      home: { type: "string" },
      org: { type: "string" },
      agent: { type: "string" },
      method: { type: "string", short: "X" },
      data: { type: "string", short: "d" },
      header: { type: "string", short: "H", multiple: true },
      json: { type: "boolean", default: false },
      output: { type: "string" },
      "schemas-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}
