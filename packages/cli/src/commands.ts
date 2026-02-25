#!/usr/bin/env node

// Check Node.js version requirement
import process from "node:process";
const MIN_NODE_VERSION = "18.0.0";
const currentNodeVersion = process.version.slice(1); // Remove 'v' prefix

function compareVersions(version1: string, version2: string): number {
  const v1parts = version1.split(".").map(Number);
  const v2parts = version2.split(".").map(Number);

  for (let i = 0; i < Math.max(v1parts.length, v2parts.length); i++) {
    const v1part = v1parts[i] || 0;
    const v2part = v2parts[i] || 0;

    if (v1part < v2part) return -1;
    if (v1part > v2part) return 1;
  }
  return 0;
}

if (compareVersions(currentNodeVersion, MIN_NODE_VERSION) < 0) {
  console.error(`❌ Error: Node.js ${MIN_NODE_VERSION} or higher is required.`);
  console.error(`   Current version: ${process.version}`);
  console.error(`   Please upgrade Node.js: https://nodejs.org/`);
  process.exit(1);
}

// Suppress punycode deprecation warning from dependencies
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name === "DeprecationWarning" &&
    warning.message.includes("punycode")
  ) {
    return; // Ignore punycode deprecation warnings
  }
  console.warn(warning.message);
});

import { Command } from "commander";
import chalk from "chalk";
import { writeFile } from "fs/promises";
import { spawn } from "child_process";
import { deleteSession, readSession, setToken } from "./lib/session.js";
import { DECO_CMS_API_LOCAL } from "./lib/constants.js";
import { readDeconfigHead, writeDeconfigHead } from "./lib/deconfig-head.js";
import {
  getAppDomain,
  getConfig,
  getLocal,
  readWranglerConfig,
  setLocal,
} from "./lib/config.js";
import { loginCommand } from "./commands/auth/login.js";
import { whoamiCommand } from "./commands/auth/whoami.js";
import { configureCommand } from "./commands/config/configure.js";
import { deploy } from "./commands/hosting/deploy.js";
import { listApps } from "./commands/hosting/list.js";
import { promoteApp } from "./commands/hosting/promote.js";
import { createCommand } from "./commands/create/create.js";
import { devCommand } from "./commands/dev/dev.js";
import { link } from "./commands/dev/link.js";
import { meshLinkCommand } from "./commands/mesh/link.js";
import { resolveMeshUrl } from "./lib/mesh-url.js";
import { genEnv } from "./commands/gen/gen.js";
import { upgradeCommand } from "./commands/update/upgrade.js";
import { updateCommand } from "./commands/update/update.js";
import { addCommand } from "./commands/add/add.js";
import { addRegistryCommand } from "./commands/add/add-registry.js";
import {
  autocompleteIntegrations,
  callToolCommand,
} from "./commands/tools/call-tool.js";
import { completionCommand } from "./commands/completion/completion.js";
import { installCompletionCommand } from "./commands/completion/install.js";
import {
  cloneCommand,
  deleteCommand,
  getCommand,
  listCommand,
  pullCommand,
  pushCommand,
  putCommand,
  watchCommand,
} from "./commands/deconfig/index.js";
import { exportCommand, importCommand } from "./commands/projects/index.js";
import { publishApp } from "./commands/registry/publish.js";
import { detectRuntime } from "./lib/runtime.js";
import { packageInfo as packageJson } from "./lib/package-info.js";

// Login command implementation
const login = new Command("login")
  .description("Log in to admin.decocms.com and retrieve tokens for CLI usage.")
  .action(async () => {
    try {
      await loginCommand();
      console.log("✅ Successfully logged in to admin.decocms.com");
    } catch (error) {
      console.error(
        "❌ Login failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Placeholder for logout command implementation
const logout = new Command("logout")
  .description("Log out of admin.decocms.com and remove local session data.")
  .action(async () => {
    try {
      await deleteSession();
      console.log("Logged out successfully. Session data removed.");
    } catch (e) {
      if (e instanceof Error) {
        console.error("Failed to log out:", e.message);
      } else {
        console.error("Failed to log out:", String(e));
      }
    }
  });

// Whoami command implementation
const whoami = new Command("whoami")
  .description("Print info about the current session.")
  .action(whoamiCommand);

// Configure command implementation
const configure = new Command("configure")
  .alias("config")
  .description("Save configuration options for the current directory.")
  .action(async () => {
    try {
      await configureCommand(getLocal());
    } catch (error) {
      console.error(
        "❌ Configuration failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

const hostingList = new Command("list")
  .description("List all apps in the current workspace.")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      const session = await readSession();
      const workspace = options.workspace || session?.workspace;

      if (!workspace) {
        console.error(
          "❌ No workspace specified. Use -w flag or run 'deco configure' first.",
        );
        process.exit(1);
      }

      await listApps({ workspace });
    } catch (error) {
      console.error(
        "❌ Failed to list apps:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Hosting deploy command implementation
const hostingDeploy = new Command("deploy")
  .description("Deploy the current directory into the current workspace.")
  .option("-w, --workspace <workspace>", "Workspace name")
  .option("-a, --app <app>", "App name")
  .option("-y, --yes", "Skip confirmation")
  .option("-p, --public", "Make the app public in the registry")
  .option(
    "-f, --force",
    "Force the deployment even if there are breaking changes",
  )
  .option(
    "--dry-run",
    "Write deploy manifest to local filesystem instead of deploying",
  )
  .option("--no-promote", "Do not promote the deployment to production routes")
  .option(
    "-e, --env <value>",
    'Set environment variables: KEY=VALUE, JSON object {"KEY":"VALUE"}, or file path /path/to/.env (can be used multiple times, overrides .dev.vars)',
    (value, previous: string[] | undefined) => {
      return previous ? [...previous, value] : [value];
    },
  )
  .argument("[cwd]", "Working directory")
  .action(async (cwd, options) => {
    try {
      const config = await getConfig({
        inlineOptions: options,
      });
      const wranglerConfig = await readWranglerConfig();
      const assetsDirectory = wranglerConfig.assets?.directory;
      const app =
        options.app ??
        (typeof wranglerConfig.name === "string"
          ? wranglerConfig.name
          : "my-app");

      await deploy({
        ...config,
        app,
        skipConfirmation: options.yes,
        cwd: cwd ?? process.cwd(),
        unlisted: !options.public,
        assetsDirectory,
        force: options.force,
        dryRun: options.dryRun,
        promote: options.promote ?? true,
        inlineEnvVars: options.env,
      });
    } catch (error) {
      console.error(
        "❌ Deployment failed:",
        error instanceof Error ? error.message : JSON.stringify(error),
      );
      process.exit(1);
    }
  });

// Hosting promote command implementation
const hostingPromote = new Command("promote")
  .description("Promote a deployment to an existing route pattern.")
  .option("-w, --workspace <workspace>", "Workspace name")
  .option("-a, --app <app>", "App name")
  .option("-d, --deployment <deployment>", "Deployment ID")
  .option(
    "-r, --route <route>",
    "Route pattern (defaults to appName.deco.page)",
  )
  .option("-y, --yes", "Skip confirmation")
  .action(async (options) => {
    try {
      const config = await getConfig({
        inlineOptions: options,
      });

      let app = options.app;
      if (!app) {
        try {
          const wranglerConfig = await readWranglerConfig();
          app =
            typeof wranglerConfig.name === "string"
              ? wranglerConfig.name
              : undefined;
        } catch {
          // No wrangler config found, app will remain undefined
        }
      }

      await promoteApp({
        workspace: config.workspace,
        local: config.local,
        appSlug: app,
        deploymentId: options.deployment,
        routePattern: options.route,
        skipConfirmation: options.yes,
      });
    } catch (error) {
      console.error(
        "❌ Promotion failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Link command implementation
const linkCmd = new Command("link")
  .description("Link a local folder to Mesh, or link to a remote domain.")
  .argument("[folder]", "Local folder to link to Mesh (omit for tunnel mode)")
  .option("-p, --port <port>", "Port to link (tunnel mode)", parseInt)
  .option("-e, --env <env>", "Environment variable to set (tunnel mode)")
  .option(
    "--mesh-url <url>",
    "Mesh instance URL (auto-detected if not provided)",
  )
  .allowUnknownOption()
  .action(async (folder, options, cmd) => {
    // New behavior: folder argument means Mesh link mode
    if (folder) {
      try {
        await meshLinkCommand(folder, options.meshUrl);
      } catch (error) {
        console.error(
          chalk.red("✗") + " Link failed:",
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      }
      return;
    }

    // No folder: check if local mesh is running → default to current dir
    try {
      const meshUrl = await resolveMeshUrl(options.meshUrl);
      const isLocal =
        meshUrl.includes("localhost") || meshUrl.includes("127.0.0.1");

      if (isLocal) {
        // Local mesh detected — link current directory
        await meshLinkCommand(".", options.meshUrl);
        return;
      }
    } catch {
      // resolveMeshUrl failed — fall through to legacy tunnel
    }

    // Legacy behavior: tunnel mode (no local mesh detected)
    try {
      const runCommand = cmd.args;

      await link({
        port: options.port,
        onBeforeRegister: (server) => {
          if (runCommand.length === 0) {
            console.log(
              "⚠️  No command provided. Tunnel will connect to existing service on port.",
            );
            return;
          }

          const [command, ...args] = runCommand;
          console.log(`🔗 Starting command: ${command} ${args.join(" ")}`);

          const childProcess = spawn(command, args, {
            stdio: "inherit",
            shell: true,
            env: { ...process.env, [options.env ?? "BASE_URL"]: server },
          });

          childProcess.on("error", (error: Error) => {
            console.error("❌ Failed to start command:", error.message);
            process.exit(1);
          });

          return childProcess;
        },
      });
    } catch (error) {
      console.error(
        "❌ Link failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

const upgrade = new Command("upgrade")
  .description("Upgrade the deco CLI to the latest version.")
  .action(upgradeCommand);

const update = new Command("update")
  .description("Update Deco dependencies to their latest versions.")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (options) => {
    try {
      await updateCommand({ yes: options.yes });
    } catch (error) {
      console.error(
        "❌ Update failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Dev command implementation
const dev = new Command("dev")
  .description("Start a development server.")
  .option(
    "--clean-build-dir <directory>",
    "Clean the build directory before starting the development server",
    (directory) => {
      return {
        enabled: true,
        directory,
      };
    },
  )
  .option(
    "--gen-watch [path]",
    "Watch for TypeScript file changes and regenerate deco.gen.ts (defaults to current directory)",
  )
  .option("--vite", "Use Vite for development server")
  .action((options) => {
    devCommand({
      cleanBuildDirectory: options.cleanBuildDir,
      genWatch: options.genWatch === true ? "." : options.genWatch,
      command: options.vite ? ["vite"] : undefined,
    });
  });

// Create command implementation
const create = new Command("create")
  .description("Create a new project from a template.")
  .argument("[project-name]", "Name of the project")
  .action(async (projectName) => {
    try {
      const config = await getConfig().catch(() => ({}));
      await createCommand(projectName, config);
    } catch (error) {
      console.error(
        "❌ Project creation failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Add installed integrations command implementation
const addInstalled = new Command("installed")
  .description("Add installed integrations to the current project.")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      await addCommand({
        workspace: options.workspace,
        local: getLocal(),
      });
    } catch (error) {
      console.error(
        "❌ Failed to add integrations:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Add from registry command implementation
const addRegistry = new Command("registry")
  .description("Add apps from the registry to the current project.")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      await addRegistryCommand({
        workspace: options.workspace,
        local: getLocal(),
      });
    } catch (error) {
      console.error(
        "❌ Failed to add registry apps:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Add command parent - defaults to registry search
const add = new Command("add")
  .description("Add integrations from the registry to the current project.")
  .argument("[app-name]", "Registry app name (e.g., @deco/pinecone-assistant)")
  .option("-w, --workspace <workspace>", "Workspace name")
  .option("--no-gen", "Skip generating types after adding")
  .addCommand(addInstalled)
  .addCommand(addRegistry)
  .action(async (appName, options) => {
    // If app name provided, add from registry directly
    if (appName) {
      try {
        await addRegistryCommand({
          workspace: options.workspace,
          local: getLocal(),
          appName,
          skipGen: !options.gen,
        });
      } catch (error) {
        console.error(
          "❌ Failed to add registry app:",
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      }
      return;
    }

    // Default behavior: search and add from registry interactively
    try {
      await addRegistryCommand({
        workspace: options.workspace,
        local: getLocal(),
      });
    } catch (error) {
      console.error(
        "❌ Failed to add registry apps:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Call-tool command implementation
const callTool = new Command("call-tool")
  .description("Call a tool on an integration using MCP protocol.")
  .argument("<tool>", "Name of the tool to call")
  .option(
    "-i, --integration <integration>",
    "Integration ID to call the tool on",
  )
  .option("-p, --payload <payload>", "JSON payload to send to the tool")
  .option(
    "--set <key=value>",
    "Set a key-value pair in the payload (can be used multiple times)",
    (value, previous: string[] | undefined) => {
      return previous ? [...previous, value] : [value];
    },
  )
  .option("-w, --workspace <workspace>", "Workspace name")
  .configureHelp({
    subcommandTerm: (cmd) => cmd.name(), // for auto-completion
  })
  .action(async (toolName, options) => {
    // Validate required integration parameter
    if (!options.integration) {
      console.error(
        "❌ Integration ID is required. Use -i or --integration flag.",
      );

      // Show available integrations for user convenience
      try {
        console.log("🔍 Available integrations:");
        const integrations = await autocompleteIntegrations("");
        if (integrations.length > 0) {
          integrations.slice(0, 10).forEach((id) => console.log(`  • ${id}`));
          if (integrations.length > 10) {
            console.log(`  ... and ${integrations.length - 10} more`);
          }
        } else {
          console.log(
            "  No integrations found. Run 'deco add' to add integrations.",
          );
        }
      } catch {
        console.log("  Run 'deco add' to add integrations.");
      }

      process.exit(1);
    }

    try {
      await callToolCommand(toolName, {
        integration: options.integration,
        payload: options.payload,
        set: options.set,
        workspace: options.workspace,
      });
    } catch (error) {
      console.error(
        "❌ Tool call failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Completion command implementation (internal command)
const completion = new Command("completion")
  .description("Generate shell completions (internal command)")
  .argument("<type>", "Type of completion to generate")
  .option("--current <current>", "Current word being completed")
  .option("--previous <previous>", "Previous word in command line")
  .option("--line <line>", "Full command line")
  .action(async (type, options) => {
    try {
      await completionCommand(type, {
        current: options.current,
        previous: options.previous,
        line: options.line,
      });
    } catch {
      // Silently fail for completions
    }
  });

// Install completion command
const installCompletion = new Command("install-completion")
  .description("Install shell completion scripts")
  .argument(
    "[shell]",
    "Target shell (bash, zsh). Auto-detected if not specified",
  )
  .option("-o, --output <path>", "Output path for completion script")
  .action(async (shell, options) => {
    try {
      await installCompletionCommand(shell, {
        output: options.output,
      });
    } catch (error) {
      console.error(
        "❌ Failed to install completion:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Hosting parent command
const hosting = new Command("hosting")
  .description("Manage hosting apps in a workspace.")
  .addCommand(hostingList)
  .addCommand(hostingDeploy)
  .addCommand(hostingPromote);

const gen = new Command("gen")
  .description("Generate the environment that will be used to run the app.")
  .option(
    "-s, --self <url>",
    "Useful to generate a SELF binding for own types based on local mcp server.",
  )
  .option(
    "-o, --output <path>",
    "Output path for the generated environment file.",
  )
  .action(async (options) => {
    try {
      const wranglerConfig = await readWranglerConfig();
      const config = await getConfig({});
      const env = await genEnv({
        workspace: config.workspace,
        local: config.local,
        bindings: config.bindings,
        selfUrl:
          options.self ??
          `https://${getAppDomain(
            config.workspace,
            wranglerConfig.name ?? "my-app",
          )}/mcp`,
      });
      if (options.output) {
        await writeFile(options.output, env);
      } else {
        console.log(env);
      }
    } catch (error) {
      console.error(
        "❌ Failed to generate environment:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Get command for deconfig
const deconfigGet = new Command("get")
  .description("Get a file from a deconfig branch.")
  .argument("<path>", "File path to get")
  .option("-b, --branch <branchName>", "Branch name", "main")
  .option("-o, --output <file>", "Output file (defaults to stdout)")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (path, options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await getCommand({
        path,
        branch: finalOptions.branch,
        output: options.output,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (options.branch || options.workspace || headConfig) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: headConfig?.path || ".",
          pathFilter: headConfig?.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ Get failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Put command for deconfig
const deconfigPut = new Command("put")
  .description("Put a file to a deconfig branch.")
  .argument("<path>", "File path to put")
  .option("-b, --branch <branchName>", "Branch name", "main")
  .option("-f, --file <file>", "Local file to upload")
  .option("-c, --content <content>", "Content to upload")
  .option("-m, --metadata <metadata>", "Metadata JSON string")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (path, options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await putCommand({
        path,
        branch: finalOptions.branch,
        file: options.file,
        content: options.content,
        metadata: options.metadata,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (options.branch || options.workspace || headConfig) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: headConfig?.path || ".",
          pathFilter: headConfig?.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ Put failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Watch command for deconfig
const deconfigWatch = new Command("watch")
  .description("Watch a deconfig branch for changes.")
  .option("-b, --branch <branchName>", "Branch name", "main")
  .option("-p, --path <path>", "Path filter for watching specific files", ".")
  .option(
    "--from-ctime <ctime>",
    "Start watching from this ctime",
    (value) => parseInt(value),
    1,
  )
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
        path: options.path || headConfig?.path || ".",
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await watchCommand({
        branch: finalOptions.branch,
        path: finalOptions.path,
        fromCtime: options.fromCtime,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (options.branch || options.workspace || options.path || headConfig) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: finalOptions.path,
          pathFilter: headConfig?.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ Watch failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Clone command for deconfig
const deconfigClone = new Command("clone")
  .description("Clone a deconfig branch to a local directory.")
  .option("-b, --branch <branchName>", "Branch name to clone", "main")
  .requiredOption(
    "--path <path>",
    "Local directory path to clone files to",
    ".",
  )
  .option("--path-filter <filter>", "Filter files by path pattern")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      const config = await getConfig({
        inlineOptions: { workspace: options.workspace },
      });
      await cloneCommand({
        branchName: options.branch,
        path: options.path,
        pathFilter: options.pathFilter,
        workspace: config.workspace,
        local: config.local,
      });
    } catch (error) {
      console.error(
        "❌ Clone failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Push command for deconfig
const deconfigPush = new Command("push")
  .description(
    "Push local files to a deconfig branch (rsync-like behavior with change detection)",
  )
  .option("-b, --branch <branchName>", "Branch name to push to", "main")
  .requiredOption(
    "--path <path>",
    "Local directory path to push files from",
    ".",
  )
  .option("--path-filter <filter>", "Filter files by path pattern")
  .option("--dry-run", "Show what would be pushed without making changes")
  .option("--watch", "Watch directory for changes and auto-push modified files")
  .option("-w, --workspace <workspace>", "Workspace name")
  .addHelpText(
    "after",
    `
Examples:
  $ deco deconfig push --path ./src --branch main
  $ deco deconfig push --path ./docs --path-filter "/docs/" --dry-run
  $ deco deconfig push --path ./src --watch --branch main

This command works like rsync:
- Compares local file hashes with remote file hashes
- Only uploads changed files (new or modified content)
- Respects .deconfigignore files (gitignore-style patterns)
- Built-in patterns: node_modules/, .git/, .deconfig/, .DS_Store, *.tmp, *.temp, .env.local
- Watch mode: Monitors directory and auto-pushes changes (500ms debounce)

.deconfigignore syntax (like .gitignore):
  *.log        # ignore all .log files
  /temp        # ignore temp in project root only
  build/       # ignore build directories
  !important.txt # negate pattern (include file)

Watch mode features:
- Performs initial push, then monitors for file changes
- Debounces rapid changes (500ms delay) to avoid spam
- Respects .deconfigignore patterns
- Graceful shutdown with Ctrl+C

Note: Deletion detection is not yet implemented - files deleted locally
will remain on the remote branch until manually deleted with 'deco deconfig delete'.
`,
  )
  .action(async (options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
        path: options.path || headConfig?.path || ".",
        pathFilter: options.pathFilter || headConfig?.pathFilter,
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await pushCommand({
        branchName: finalOptions.branch,
        path: finalOptions.path,
        pathFilter: finalOptions.pathFilter,
        dryRun: options.dryRun,
        watch: options.watch,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (
        options.branch ||
        options.workspace ||
        options.path ||
        options.pathFilter ||
        headConfig
      ) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: finalOptions.path,
          pathFilter: finalOptions.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ Push failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Pull command for deconfig
const deconfigPull = new Command("pull")
  .description("Pull changes from a deconfig branch to local directory.")
  .option("-b, --branch <branchName>", "Branch name to pull from", "main")
  .requiredOption("--path <path>", "Local directory path to pull files to", ".")
  .option("--path-filter <filter>", "Filter files by path pattern")
  .option("--dry-run", "Show what would be changed without making changes")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
        path: options.path || headConfig?.path || ".",
        pathFilter: options.pathFilter || headConfig?.pathFilter,
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await pullCommand({
        branchName: finalOptions.branch,
        path: finalOptions.path,
        pathFilter: finalOptions.pathFilter,
        dryRun: options.dryRun,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (
        options.branch ||
        options.workspace ||
        options.path ||
        options.pathFilter ||
        headConfig
      ) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: finalOptions.path,
          pathFilter: finalOptions.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ Pull failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// List command for deconfig
const deconfigList = new Command("list")
  .description("Interactively browse and view files in a deconfig branch.")
  .option("-b, --branch <branchName>", "Branch name to list files from", "main")
  .option("--path-filter <filter>", "Filter files by path pattern")
  .option(
    "--format <format>",
    "Content display format: plainString, json, base64",
    "plainString",
  )
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
        pathFilter: options.pathFilter || headConfig?.pathFilter,
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await listCommand({
        branchName: finalOptions.branch,
        pathFilter: finalOptions.pathFilter,
        format: options.format,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (
        options.branch ||
        options.workspace ||
        options.pathFilter ||
        headConfig
      ) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: headConfig?.path || ".",
          pathFilter: finalOptions.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ List failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Delete command for deconfig
const deconfigDelete = new Command("delete")
  .description("Delete a file from a deconfig branch.")
  .argument("<path>", "File path to delete")
  .option("-b, --branch <branchName>", "Branch name", "main")
  .option("-w, --workspace <workspace>", "Workspace name")
  .action(async (path, options) => {
    try {
      // Read from HEAD file
      const headConfig = await readDeconfigHead();

      // Merge: CLI flags override HEAD values
      const finalOptions = {
        branch: options.branch || headConfig?.branch || "main",
        workspace: options.workspace || headConfig?.workspace,
      };

      const config = await getConfig({
        inlineOptions: { workspace: finalOptions.workspace },
      });

      await deleteCommand({
        path,
        branchName: finalOptions.branch,
        workspace: config.workspace,
        local: config.local,
      });

      // Update HEAD with values used (if flags were provided or HEAD exists)
      if (options.branch || options.workspace || headConfig) {
        await writeDeconfigHead({
          workspace: config.workspace,
          branch: finalOptions.branch,
          path: headConfig?.path || ".",
          pathFilter: headConfig?.pathFilter,
          local: config.local,
        });
      }
    } catch (error) {
      console.error(
        "❌ Delete failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Deconfig parent command
export const deconfig = new Command("deconfig")
  .description("Manage deconfig filesystem operations.")
  .addCommand(deconfigGet)
  .addCommand(deconfigPut)
  .addCommand(deconfigWatch)
  .addCommand(deconfigClone)
  .addCommand(deconfigPush)
  .addCommand(deconfigPull)
  .addCommand(deconfigList)
  .addCommand(deconfigDelete);

// Project export command
const projectExport = new Command("export")
  .description("Export a project to a local directory.")
  .option("--org <slug>", "Organization slug")
  .option("--project <slug>", "Project slug")
  .option("--out <dir>", "Output directory")
  .option("--force", "Overwrite existing files in output directory")
  .option("--local", "Use local API server (http://localhost:8787)")
  .action(async (options) => {
    try {
      const config = await getConfig();
      await exportCommand({
        org: options.org,
        project: options.project,
        out: options.out,
        force: options.force,
        local: options.local || config.local,
      });
    } catch (error) {
      console.error(
        "❌ Export failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Project import command
const projectImport = new Command("import")
  .description("Import a project from a local directory.")
  .argument(
    "[directory]",
    "Source directory (default: current directory)",
    "./",
  )
  .option("--from <dir>", "Source directory (alternative to positional arg)")
  .option("--org <slug>", "Destination organization slug")
  .option("--slug <slug>", "Project slug override")
  .option("--title <title>", "Project title override")
  .action(async (directory, options) => {
    try {
      const config = await getConfig();
      // Prefer --from flag, fallback to positional argument
      const fromDir = options.from || directory;
      await importCommand({
        from: fromDir,
        org: options.org,
        slug: options.slug,
        title: options.title,
        local: config.local,
      });
    } catch (error) {
      console.error(
        "❌ Import failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Project parent command
const project = new Command("project")
  .description("Manage MCP project import/export.")
  .addCommand(projectExport)
  .addCommand(projectImport);

// Registry publish command
const registryPublish = new Command("publish")
  .description(
    "Publish an app to the registry from a JSON config file or stdin.",
  )
  .option(
    "-f, --file <file>",
    "Path to JSON config file (reads from stdin if not provided)",
  )
  .option("-w, --workspace <workspace>", "Workspace name")
  .option("-y, --yes", "Skip confirmation")
  .action(async (options) => {
    try {
      const session = await readSession();
      const workspace = options.workspace || session?.workspace;

      if (!workspace) {
        console.error(
          "❌ No workspace specified. Use -w flag or run 'deco configure' first.",
        );
        process.exit(1);
      }

      await publishApp({
        file: options.file,
        workspace,
        local: getLocal(),
        skipConfirmation: options.yes,
      });
    } catch (error) {
      console.error(
        "❌ Publish failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Registry parent command
const registry = new Command("registry")
  .description("Manage apps in the registry.")
  .addCommand(registryPublish);

// Main CLI program
export const program = new Command()
  .name(packageJson.name)
  .version(packageJson.version)
  .description(packageJson.description)
  .configureOutput({
    writeOut: (str) => {
      // Customize version output to include runtime info
      if (
        str.includes(packageJson.version) &&
        str.trim() === packageJson.version
      ) {
        const runtime = detectRuntime();
        process.stdout.write(`${packageJson.version} (${runtime})\n`);
      } else {
        process.stdout.write(str);
      }
    },
    writeErr: (str) => process.stderr.write(str),
  })
  .option(
    "-t, --token <token>",
    "Authentication token to use for API requests",
    (token) => {
      setToken(token);
    },
  )
  .option(
    "-l, --local",
    `Deploy the app locally (Needs admin.decocms.com running at ${DECO_CMS_API_LOCAL})`,
    () => {
      setLocal(true);
    },
  )
  .addHelpText("after", () => {
    const runtime = detectRuntime();
    return `\nRuntime: ${runtime}`;
  })
  .addCommand(login)
  .addCommand(logout)
  .addCommand(whoami)
  .addCommand(hosting)
  .addCommand(hostingDeploy)
  .addCommand(hostingPromote)
  .addCommand(dev)
  .addCommand(configure)
  .addCommand(add)
  .addCommand(callTool)
  .addCommand(upgrade)
  .addCommand(update)
  .addCommand(linkCmd)
  .addCommand(gen)
  .addCommand(create)
  .addCommand(deconfig)
  .addCommand(project)
  .addCommand(registry)
  .addCommand(completion)
  .addCommand(installCompletion);
