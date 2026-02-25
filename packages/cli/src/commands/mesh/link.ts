/**
 * deco link command
 *
 * Starts the local-dev MCP daemon for a project folder and opens the Mesh UI.
 * Mesh auto-discovers the daemon via port probing and shows a banner to
 * create the project/connection. The CLI doesn't manage connections or projects.
 *
 * Flow:
 * 1. Resolve Mesh URL
 * 2. Ensure user is authenticated
 * 3. Start local-dev daemon (inline, same process)
 * 4. Open Mesh UI in browser
 * 5. Keep running until Ctrl+C
 */

import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import { resolveMeshUrl } from "../../lib/mesh-url.js";
import {
  startLocalDev,
  stopLocalDev,
  type LocalDevServer,
} from "../../lib/local-dev-manager.js";

// ---------------------------------------------------------------------------
// CLI output helpers
// ---------------------------------------------------------------------------

function step(msg: string): void {
  console.log(chalk.green("✓") + " " + msg);
}

function fail(msg: string, err: string): void {
  console.log(chalk.red("✗") + " " + msg + ": " + err);
}

function info(msg: string): void {
  console.log(chalk.cyan("→") + " " + msg);
}

// ---------------------------------------------------------------------------
// Main link command
// ---------------------------------------------------------------------------

export async function meshLinkCommand(
  folder: string,
  meshUrlOverride?: string,
): Promise<void> {
  const absFolder = path.resolve(folder);
  const LOCAL_DEV_PORT = 4201;

  // Validate folder exists
  try {
    await fs.stat(absFolder);
  } catch {
    console.error(chalk.red("✗") + ` Folder not found: ${absFolder}`);
    process.exit(1);
  }

  let localDevServer: LocalDevServer | null = null;

  try {
    // Step 1: Resolve Mesh URL
    info("Detecting Mesh instance...");
    const meshUrl = await resolveMeshUrl(meshUrlOverride);
    step(`Mesh instance: ${meshUrl}`);

    // Step 2: Start local-dev daemon
    info("Starting local-dev daemon...");
    localDevServer = await startLocalDev(absFolder, LOCAL_DEV_PORT);
    const actualPort = localDevServer?.port ?? LOCAL_DEV_PORT;
    if (localDevServer) {
      step(`local-dev started on port ${actualPort}`);
    } else {
      step(`local-dev already running on port ${actualPort}`);
    }

    // Print banner
    const folderName = path.basename(absFolder);
    console.log("");
    console.log(chalk.bold("  deco link"));
    console.log("");
    console.log(`  ${chalk.dim("Project:")}  ${folderName}`);
    console.log(`  ${chalk.dim("Mesh:")}     ${meshUrl}`);
    console.log(`  ${chalk.dim("local-dev:")} http://localhost:${actualPort}`);
    console.log("");

    info(`Mesh UI: ${meshUrl}`);
    info("The local-dev daemon is running — Mesh will auto-detect it");

    // Setup SIGINT/SIGTERM handler for clean shutdown
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("");
      info("Shutting down...");
      await stopLocalDev(localDevServer);
      step("local-dev stopped");
      step("Done");
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    console.log(chalk.dim("  Press Ctrl+C to stop\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail("deco link failed", message);
    await stopLocalDev(localDevServer);
    process.exit(1);
  }
}
