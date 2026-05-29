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
    "no-tui": {
      type: "boolean",
      default: false,
    },
    "no-local-mode": {
      type: "boolean",
      default: false,
    },
    "local-sandbox-provider": {
      type: "boolean",
      default: false,
    },
    vibe: {
      type: "boolean",
      default: false,
    },
    target: { type: "string" },
    env: { type: "string", short: "e" },
    "dry-run": {
      type: "boolean",
      default: false,
    },
    batch: { type: "string" },
    limit: { type: "string" },
    org: { type: "string" },
  },
  allowPositionals: true,
});

// ── Help ───────────────────────────────────────────────────────────────
if (values.help) {
  console.log(`
Deco CMS — Open-source control plane for your AI agents

Usage:
  deco [options]                     Start server with Ink UI
  deco dev [options]                 Start dev server (Vite + hot reload)
  deco services <up|down|status>     Manage services (Postgres, NATS)
  deco init <directory>              Scaffold a new MCP app
  deco auth <login|whoami|logout>    Manage CLI authentication
  deco link [options]                Start the desktop-side link daemon
  deco backfill-assets               Hoist legacy inline media out of threads + connections
  deco completion [shell]            Install shell completions

Server Options:
  -p, --port <port>     Port to listen on (default: 3000, or PORT env var)
  --home <path>         Data directory (default: ~/deco/, or DATA_DIR env var)
  --no-local-mode       Disable auto-login (use cloud/SSO auth)
  --skip-migrations     Skip database migrations on startup
  --no-tui              Disable Ink UI, plain stdout (CI mode)
  --vibe                Play synthwave soundtrack while running
  -h, --help            Show this help message
  -v, --version         Show version

Dev Options:
  --vite-port <port>            Vite dev server port (default: 4000)
  --base-url <url>              Base URL for the server
  --local-sandbox-provider      Auto-spawn the local link daemon (desktop sandbox provider)

Auth Options:
  --target <url>        Decocms target (default: https://studio.decocms.com)

Link Options:
  --port <port>     Local port for the daemon (default: 5174)

Backfill Options (backfill-assets):
  --target <t>          all | threads | connections (default: all)
  --org <slug|id>       Restrict to a single organization
  --dry-run             Report what would change without uploading or writing
  --batch <n>           Rows scanned per page (default: 500)
  --limit <n>           Cap total rows scanned per target (default: all)
  --base-url <url>      Public origin for stored URLs (default: BASE_URL env)

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
  deco dev                        Start dev server
  deco init my-app                Scaffold a new MCP app
  deco auth login                 Log in to studio.decocms.com
  deco auth whoami                Show current session

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
  });
  process.exit(0);
}

// ── Backfill: hoist legacy inline media out of stored rows ──────────────
if (command === "backfill-assets") {
  const { backfillThreadAssetsCommand } = await import(
    "./cli/commands/backfill-assets"
  );
  const targetArg = (values.target as string | undefined) ?? "all";
  if (!["all", "threads", "connections"].includes(targetArg)) {
    console.error(
      `Invalid --target "${targetArg}". Use: all | threads | connections`,
    );
    process.exit(1);
  }
  const code = await backfillThreadAssetsCommand({
    dryRun: values["dry-run"] === true,
    batch: values.batch ? Number(values.batch) : 500,
    limit: values.limit ? Number(values.limit) : undefined,
    baseUrl: values["base-url"],
    org: values.org as string | undefined,
    target: targetArg as "all" | "threads" | "connections",
  });
  process.exit(code);
}

// ── Auth / Link helpers ────────────────────────────────────────────────
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
    const code = await whoamiCommand({ dataDir });
    process.exit(code);
  }
  if (sub === "logout") {
    const { logoutCommand } = await import("./cli/commands/auth/logout");
    const code = await logoutCommand({ dataDir });
    process.exit(code);
  }
  console.error(`Usage: decocms auth <login|whoami|logout>`);
  process.exit(1);
}

// ── Link command ───────────────────────────────────────────────────────
if (command === "link") {
  const { runLinkCommand } = await import("./cli/commands/link");
  // The top-level `parseArgs` declares `--port` with a default of 3000
  // (for the server command). Only honor it for `deco link` if the user
  // actually passed `--port`/`-p` on the command line — otherwise
  // `runLinkCommand` falls back to the daemon's own default of 5174.
  const portExplicit = process.argv.some(
    (a) =>
      a === "--port" ||
      a === "-p" ||
      a.startsWith("--port=") ||
      a.startsWith("-p="),
  );
  const code = await runLinkCommand({
    port: portExplicit ? Number(values.port) : undefined,
  });
  process.exit(code);
}

// ── Dev command (Ink TUI + dev servers) ─────────────────────────────────
if (command === "dev") {
  const decoHome =
    values.home ||
    process.env.DATA_DIR ||
    process.env.DECOCMS_HOME ||
    join(process.cwd(), ".deco");

  const noTui = values["no-tui"] === true || !process.stdout.isTTY;

  const localSandboxProvider = values["local-sandbox-provider"] === true;
  const devOptions = {
    port: values.port!,
    vitePort: values["vite-port"]!,
    home: decoHome,
    baseUrl: values["base-url"],
    skipMigrations: values["skip-migrations"] === true,
    noTui,
    localMode: values["no-local-mode"] !== true,
    localSandboxProvider,
  };

  if (noTui) {
    const { printBanner } = await import("./cli/banner-art");
    printBanner(await getVersion());

    if (values.vibe === true) {
      const { startVibe } = await import("./cli/vibe/vibe-player");
      startVibe(decoHome);
    }

    const { startDevServer } = await import("./cli/commands/dev");
    const result = await startDevServer(devOptions);
    const code = await result.process.exited;
    process.exit(code);
  } else {
    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { App } = await import("./cli/app");
    const { startDevServer } = await import("./cli/commands/dev");
    const { setDevMode, setVibe, setDataDir } = await import("./cli/cli-store");

    const displayHome = decoHome.replace(homedir(), "~");
    setDevMode({ localSandboxProvider });
    setDataDir(decoHome);
    render(createElement(App, { home: displayHome }), {
      patchConsole: false,
    });

    if (values.vibe === true) {
      const { startVibe } = await import("./cli/vibe/vibe-player");
      setVibe(true);
      startVibe(decoHome);
    }

    const result = await startDevServer(devOptions);
    const code = await result.process.exited;
    process.exit(code);
  }
}

if (
  command &&
  ![
    "init",
    "completion",
    "dev",
    "services",
    "auth",
    "link",
    "backfill-assets",
  ].includes(command)
) {
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
  const { printBanner } = await import("./cli/banner-art");
  printBanner(await getVersion());

  if (values.vibe === true) {
    const { startVibe } = await import("./cli/vibe/vibe-player");
    startVibe(decoHome);
  }

  const { startServer } = await import("./cli/commands/serve");
  await startServer({ ...serveOptions, noTui: true });
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
  render(createElement(App, { home: displayHome }), {
    patchConsole: false,
  });

  {
    const { setDataDir } = await import("./cli/cli-store");
    setDataDir(decoHome);
  }

  if (values.vibe === true) {
    const { startVibe } = await import("./cli/vibe/vibe-player");
    const { setVibe } = await import("./cli/cli-store");
    setVibe(true);
    startVibe(decoHome);
  }

  await startServer(serveOptions);
}
