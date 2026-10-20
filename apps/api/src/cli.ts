#!/usr/bin/env bun
/**
 * Deco CMS CLI Entry Point
 *
 * Client commands for existing Studio instances and MCP app scaffolding.
 *
 * Run Studio with Docker Compose or Kubernetes; this CLI does not manage servers.
 */

import { parseArgs } from "util";
import { homedir } from "os";
import { join } from "path";
import { parsePositiveIntFlag } from "./cli/parse-positive-int-flag";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: {
      type: "string",
    },
    "base-url": {
      type: "string",
    },
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
    version: {
      type: "boolean",
      short: "v",
      default: false,
    },
    target: { type: "string" },
    "dry-run": {
      type: "boolean",
      default: false,
    },
    batch: { type: "string" },
    limit: { type: "string" },
    org: { type: "string" },
    method: { type: "string", short: "X" },
    data: { type: "string", short: "d" },
    header: { type: "string", short: "H", multiple: true },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

// ── Help ───────────────────────────────────────────────────────────────
if (values.help || process.argv.length === 2) {
  console.log(`
Deco CMS — Open-source control plane for your AI agents

Usage:
  deco init <directory>              Scaffold a new MCP app
  deco auth <login|whoami|token|logout>  Manage CLI authentication
  deco api <path>                    Authenticated request to the studio
  deco tools <list|describe|call>    List, inspect, and call builtin tools
  deco orgs                          List the organizations you belong to
  deco backfill-assets               Hoist legacy inline media out of threads + connections + org logos
  deco completion [shell]            Install shell completions

Options:
  --home <path>         CLI session directory (default: ~/deco/)
  -h, --help            Show this help message
  -v, --version         Show version

Run Studio with Docker Compose or Kubernetes. See the repository setup guide.

Auth Options (auth, api, tools, orgs):
  --target <url>        Decocms target (default: https://studio.decocms.com)

API Options:
  -X, --method <m>      HTTP method (default: POST with --data, else GET)
  -d, --data <body>     Request body: literal, @<file>, or @- for stdin
  -H, --header <h>      Extra header "Name: value" (repeatable)

Tools Options:
  --org <slug>          Organization slug (first path segment of the studio URL)
  -d, --data <json>     Tool arguments: literal JSON, @<file>, or @- for stdin
  --json                Print full objects from tools list and orgs

Backfill Options (backfill-assets):
  --target <t>          all | threads | connections | organizations (default: all)
  --org <slug|id>       Restrict to a single organization
  --dry-run             Report what would change without uploading or writing
  --batch <n>           Rows scanned per page (default: 500)
  --limit <n>           Cap total rows scanned per target (default: all)
  --base-url <url>      Public origin for stored URLs (default: BASE_URL env)

Examples:
  deco init my-app                Scaffold a new MCP app
  deco auth login                 Log in to studio.decocms.com
  deco auth whoami                Show current session
  deco orgs
  deco tools list --org my-org thread
  deco tools call ORGANIZATION_LIST --org my-org
  deco api "/api/my-org/fs/<volume>/list?path=/"

Documentation:
  https://decocms.com/studio
`);
  process.exit(0);
}

// ── Version helper ────────────────────────────────────────────────────
async function getVersion(): Promise<string> {
  const possiblePaths = [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];

  for (const path of possiblePaths) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const packageJson = await file.json();
        return packageJson.version;
      }
    } catch {
      // Try next path
    }
  }
  return "unknown";
}

if (values.version) {
  console.log(`Deco CMS v${await getVersion()}`);
  process.exit(0);
}

// ── Subcommand routing ─────────────────────────────────────────────────
const command = positionals[0];

if (command === "init") {
  const { initCommand } = await import("./cli/commands/init");
  await initCommand(positionals[1]);
  process.exit(0);
}

if (command === "completion") {
  const { completionCommand } = await import("./cli/commands/completion");
  await completionCommand(positionals[1]);
  process.exit(0);
}

// ── Backfill: hoist legacy inline media out of stored rows ──────────────
if (command === "backfill-assets") {
  const { backfillThreadAssetsCommand } = await import(
    "./cli/commands/backfill-assets"
  );
  const targetArg = (values.target as string | undefined) ?? "all";
  if (!["all", "threads", "connections", "organizations"].includes(targetArg)) {
    console.error(
      `Invalid --target "${targetArg}". Use: all | threads | connections | organizations`,
    );
    process.exit(1);
  }
  let batch = 500;
  let limit: number | undefined;
  try {
    batch = parsePositiveIntFlag("batch", values.batch) ?? 500;
    limit = parsePositiveIntFlag("limit", values.limit);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const code = await backfillThreadAssetsCommand({
    dryRun: values["dry-run"] === true,
    batch,
    limit,
    baseUrl: values["base-url"],
    org: values.org as string | undefined,
    target: targetArg as "all" | "threads" | "connections" | "organizations",
  });
  process.exit(code);
}

// ── Auth helpers ───────────────────────────────────────────────────────
function resolveDataDir(): string {
  return (
    values.home ||
    process.env.DATA_DIR ||
    process.env.DECOCMS_HOME ||
    join(homedir(), "deco")
  );
}

// ── Auth command ───────────────────────────────────────────────────────
if (command === "auth") {
  const sub = positionals[1];
  const dataDir = resolveDataDir();

  if (sub === "login") {
    const { loginCommand } = await import("./cli/commands/auth/login");
    const code = await loginCommand({
      dataDir,
      target: values.target,
    });
    process.exit(code);
  }
  if (sub === "whoami") {
    const { whoamiCommand } = await import("./cli/commands/auth/whoami");
    const code = await whoamiCommand({ dataDir, target: values.target });
    process.exit(code);
  }
  if (sub === "token") {
    const { tokenCommand } = await import("./cli/commands/auth/token");
    const code = await tokenCommand({ dataDir, target: values.target });
    process.exit(code);
  }
  if (sub === "logout") {
    const { logoutCommand } = await import("./cli/commands/auth/logout");
    const code = await logoutCommand({ dataDir, target: values.target });
    process.exit(code);
  }
  console.error(`Usage: decocms auth <login|whoami|token|logout>`);
  process.exit(1);
}

// ── API command ────────────────────────────────────────────────────────
if (command === "api") {
  const { apiCommand } = await import("./cli/commands/api");
  const code = await apiCommand({
    dataDir: resolveDataDir(),
    target: values.target,
    path: positionals[1],
    method: values.method,
    data: values.data,
    headers: values.header,
  });
  process.exit(code);
}

// ── Orgs command ───────────────────────────────────────────────────────
if (command === "orgs") {
  const { orgsCommand } = await import("./cli/commands/orgs");
  const code = await orgsCommand({
    dataDir: resolveDataDir(),
    target: values.target,
    json: values.json === true,
  });
  process.exit(code);
}

// ── Tools command ──────────────────────────────────────────────────────
if (command === "tools") {
  const { toolsCommand } = await import("./cli/commands/tools");
  const code = await toolsCommand({
    dataDir: resolveDataDir(),
    target: values.target,
    subcommand: positionals[1],
    arg: positionals[2],
    org: values.org,
    data: values.data,
    json: values.json === true,
  });
  process.exit(code);
}

console.error(
  command === "dev" || command === "services" || command === "serve"
    ? "Run Studio with Docker Compose or Kubernetes. Use --help for client commands."
    : `Unknown command: ${command}. Use --help for available commands.`,
);
process.exit(1);
