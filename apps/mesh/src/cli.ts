#!/usr/bin/env bun
/**
 * Deco CMS CLI Entry Point
 *
 * Routes subcommands and renders the Ink UI for server mode.
 *
 * Usage:
 *   bunx decocms                    # Start server (Ink UI)
 *   bunx decocms init <directory>   # Scaffold from decocms/mcp-app
 *   bunx decocms completion         # Shell completion setup
 */

import { parseArgs } from "util";
import { homedir } from "os";
import { join } from "path";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT || "3000",
    },
    home: {
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
    "skip-migrations": {
      type: "boolean",
      default: false,
    },
    "local-mode": {
      type: "boolean",
      default: false,
    },
    "no-tui": {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: true,
});

// ── Help ───────────────────────────────────────────────────────────────
if (values.help) {
  console.log(`
Deco CMS — Open-source control plane for your AI agents

Usage:
  deco [options]                  Start server with Ink UI
  deco init <directory>           Scaffold a new MCP app
  deco completion [shell]         Install shell completions

Server Options:
  -p, --port <port>     Port to listen on (default: 3000, or PORT env var)
  --home <path>         Data directory (default: ~/deco/, or DATA_DIR env var)
  --local-mode          Enable local mode (auto-login, no auth required)
  --skip-migrations     Skip database migrations on startup
  --no-tui              Disable Ink UI, plain stdout (CI mode)
  -h, --help            Show this help message
  -v, --version         Show version

Environment Variables:
  PORT                  Port to listen on (default: 3000)
  DATA_DIR              Data directory (default: ~/deco/)
  DATABASE_URL          Database connection URL
  NODE_ENV              Set to 'production' for production mode
  BETTER_AUTH_SECRET    Secret for authentication (auto-generated if not set)
  ENCRYPTION_KEY        Key for encrypting secrets (auto-generated if not set)

Examples:
  deco                            Start with defaults (~/deco/)
  deco -p 8080                    Start on port 8080
  deco --home ~/my-project        Custom data directory
  deco --local-mode               Enable auto-login (local dev)
  deco init my-app                Scaffold a new MCP app
  deco --no-tui                   Start without terminal UI

Documentation:
  https://decocms.com/studio
`);
  process.exit(0);
}

// ── Version ────────────────────────────────────────────────────────────
if (values.version) {
  const possiblePaths = [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];

  let version = "unknown";
  for (const path of possiblePaths) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const packageJson = await file.json();
        version = packageJson.version;
        break;
      }
    } catch {
      // Try next path
    }
  }

  console.log(`Deco CMS v${version}`);
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

// ── Server mode (default) ──────────────────────────────────────────────
const decoHome =
  values.home ||
  process.env.DATA_DIR ||
  process.env.DECOCMS_HOME ||
  join(homedir(), "deco");

const serveOptions = {
  port: values.port!,
  home: decoHome,
  skipMigrations: values["skip-migrations"] === true,
  localMode: values["local-mode"] === true,
};

const noTui = values["no-tui"] === true || !process.stdout.isTTY;

if (noTui) {
  // Plain stdout mode — no Ink, just console.log (CI-friendly)
  const { ASCII_ART } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }
  console.log("");

  const { startServer } = await import("./cli/commands/serve");
  await startServer(serveOptions);
} else {
  // Ink UI mode
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./cli/app");
  const { startServer } = await import("./cli/commands/serve");

  const displayHome = decoHome.replace(homedir(), "~");
  render(createElement(App, { home: displayHome }));

  await startServer(serveOptions);
}
