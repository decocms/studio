#!/usr/bin/env bun
/**
 * Deco CMS CLI Entry Point
 *
 * Routes subcommands and renders the Ink UI for server mode.
 *
 * Usage:
 *   bunx decocms                    # Start server (Ink UI)
 *   bunx decocms dev                # Start dev server (Ink UI + Vite)
 *   bunx decocms init <directory>   # Scaffold from decocms/mcp-app
 *   bunx decocms completion         # Shell completion setup
 *   bunx decocms services <up|down|status>  # Service management
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
    "vite-port": {
      type: "string",
      default: process.env.VITE_PORT || "4000",
    },
    home: {
      type: "string",
    },
    "base-url": {
      type: "string",
    },
    "env-file": {
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
    "no-local-mode": {
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
  deco dev [options]              Start dev server (Vite + hot reload)
  deco services <up|down|status>  Manage services (Postgres, NATS)
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

Dev Options:
  --vite-port <port>    Vite dev server port (default: 4000)
  --base-url <url>      Base URL for the server
  --env-file <path>     Path to .env file to load
  --no-local-mode       Disable auto-login (use cloud/SSO auth)

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
  deco dev                        Start dev server
  deco dev --vite-port 5000       Dev server with custom Vite port
  deco dev --env-file .env        Dev server with env file
  deco services up                Start Postgres and NATS
  deco services status            Show service status
  deco services down              Stop services
  deco init my-app                Scaffold a new MCP app
  deco --no-tui                   Start without terminal UI

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

// ── Services command (plain output, no TUI) ────────────────────────────
if (command === "services") {
  const subcommand = positionals[1];
  if (!subcommand) {
    console.error("Usage: deco services <up|down|status>");
    process.exit(1);
  }

  const decoHome =
    values.home ||
    process.env.DATA_DIR ||
    process.env.DECOCMS_HOME ||
    join(homedir(), "deco");

  const { servicesCommand } = await import("./cli/commands/services");
  await servicesCommand({
    subcommand,
    home: decoHome,
    envFile: values["env-file"],
  });
  process.exit(0);
}

// ── Dev command (Ink TUI + dev servers) ─────────────────────────────────
if (command === "dev") {
  const decoHome =
    values.home ||
    process.env.DATA_DIR ||
    process.env.DECOCMS_HOME ||
    join(process.cwd(), ".deco");

  const noTui = values["no-tui"] === true || !process.stdout.isTTY;

  const devOptions = {
    port: values.port!,
    vitePort: values["vite-port"]!,
    home: decoHome,
    baseUrl: values["base-url"],
    skipMigrations: values["skip-migrations"] === true,
    envFile: values["env-file"],
    noTui,
    localMode: values["no-local-mode"] !== true,
  };

  if (noTui) {
    const { ASCII_ART, dim } = await import("./fmt");
    console.log("");
    for (const line of ASCII_ART) {
      console.log(line);
    }
    console.log(dim(`  v${await getVersion()}`));
    console.log("");

    const { startDevServer } = await import("./cli/commands/dev");
    const result = await startDevServer(devOptions);
    const code = await result.process.exited;
    process.exit(code);
  } else {
    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { App } = await import("./cli/app");
    const { startDevServer } = await import("./cli/commands/dev");
    const { setDevMode } = await import("./cli/cli-store");

    const displayHome = decoHome.replace(homedir(), "~");
    setDevMode();
    render(createElement(App, { home: displayHome }));

    const result = await startDevServer(devOptions);
    const code = await result.process.exited;
    process.exit(code);
  }
}

if (command && !["init", "completion", "dev", "services"].includes(command)) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
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
  localMode: values["no-local-mode"] !== true,
};

const noTui = values["no-tui"] === true || !process.stdout.isTTY;

if (noTui) {
  // Plain stdout mode — no Ink, just console.log (CI-friendly)
  const { ASCII_ART, dim } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }
  console.log(dim(`  v${await getVersion()}`));
  console.log("");

  const { startServer } = await import("./cli/commands/serve");
  await startServer(serveOptions);
} else {
  // Ink UI mode
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./cli/app");
  const { startServer, interceptConsoleForTui } = await import(
    "./cli/commands/serve"
  );

  const displayHome = decoHome.replace(homedir(), "~");
  interceptConsoleForTui();
  render(createElement(App, { home: displayHome }));

  await startServer(serveOptions);
}
