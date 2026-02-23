/**
 * deco link command
 *
 * Orchestrates all foundation libs to wire a local project folder to a running
 * Mesh instance. Handles:
 * - Mesh URL resolution
 * - Better Auth authentication
 * - local-dev daemon lifecycle
 * - Connection + Project creation
 * - site-editor auto-enable for Deco sites
 * - `.deco/link.json` idempotency
 * - Browser open (no auto-login per CONTEXT.md locked decision)
 * - Clean Ctrl+C shutdown with teardown log
 */

import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";
import process from "node:process";
import { resolveMeshUrl } from "../../lib/mesh-url.js";
import { ensureMeshAuth } from "../../lib/mesh-auth.js";
import {
  createMeshSelfClient,
  callMeshTool,
  getOrganizationId,
} from "../../lib/mesh-client.js";
import { startLocalDev, stopLocalDev } from "../../lib/local-dev-manager.js";
import { slugify } from "../../lib/slugify.js";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Link state schema — persisted in .deco/link.json for idempotency
// ---------------------------------------------------------------------------

const LinkStateSchema = z.object({
  connectionId: z.string(),
  projectId: z.string(),
  projectSlug: z.string(),
  meshUrl: z.string(),
});

type LinkState = z.infer<typeof LinkStateSchema>;

// ---------------------------------------------------------------------------
// CLI output helpers (Vercel-style)
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
// Link state helpers
// ---------------------------------------------------------------------------

async function readLinkState(folder: string): Promise<LinkState | null> {
  const linkPath = path.join(folder, ".deco", "link.json");
  try {
    const content = await fs.readFile(linkPath, "utf-8");
    const parsed = JSON.parse(content);
    const result = LinkStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function writeLinkState(folder: string, state: LinkState): Promise<void> {
  const decoDir = path.join(folder, ".deco");
  await fs.mkdir(decoDir, { recursive: true });
  const linkPath = path.join(decoDir, "link.json");
  await fs.writeFile(linkPath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Deco site detection
// ---------------------------------------------------------------------------

function isDecoSite(folder: string): boolean {
  return existsSync(path.join(folder, ".deco"));
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const browserCommands: Record<string, string> = {
    linux: "xdg-open",
    darwin: "open",
    win32: "start",
    freebsd: "xdg-open",
    openbsd: "xdg-open",
    sunos: "xdg-open",
    aix: "open",
  };

  const browser =
    process.env.BROWSER ?? browserCommands[process.platform] ?? "open";

  const command =
    process.platform === "win32" && browser === "start"
      ? spawn("cmd", ["/c", "start", url], { detached: true })
      : spawn(browser, [url], { detached: true });

  command.unref();
  command.on("error", () => {
    // Ignore — URL is already printed as fallback
  });
}

// ---------------------------------------------------------------------------
// Main link command
// ---------------------------------------------------------------------------

export async function meshLinkCommand(
  folder: string,
  meshUrlOverride?: string,
): Promise<void> {
  // Resolve absolute path
  const absFolder = path.resolve(folder);

  // Validate folder exists
  try {
    await fs.stat(absFolder);
  } catch {
    console.error(chalk.red("✗") + ` Folder not found: ${absFolder}`);
    process.exit(1);
  }

  let localDevChild: ChildProcess | null = null;
  const LOCAL_DEV_PORT = 4201;

  try {
    // Step 1: Resolve Mesh URL
    info("Detecting Mesh instance...");
    const meshUrl = await resolveMeshUrl(meshUrlOverride);
    step(`Mesh instance: ${meshUrl}`);

    // Step 2: Authenticate
    info("Authenticating with Mesh...");
    const apiKey = await ensureMeshAuth(meshUrl);
    step("Authenticated");

    // Step 3: Start local-dev
    info("Starting local-dev daemon...");
    localDevChild = await startLocalDev(absFolder, LOCAL_DEV_PORT);
    if (localDevChild) {
      step(`local-dev started on port ${LOCAL_DEV_PORT}`);
    } else {
      step(`local-dev already running on port ${LOCAL_DEV_PORT}`);
    }

    // Step 4: Check for existing link state
    const existing = await readLinkState(absFolder);

    let connectionId: string;
    let projectId: string;
    let projectSlug: string;

    if (existing) {
      // Reuse existing connection + project
      step(`Reusing existing connection (${existing.connectionId})`);
      step(`Reusing existing project (${existing.projectSlug})`);
      connectionId = existing.connectionId;
      projectId = existing.projectId;
      projectSlug = existing.projectSlug;
    } else {
      // Create new Connection
      info("Registering connection in Mesh...");
      const orgId = await getOrganizationId(meshUrl, apiKey);
      const client = await createMeshSelfClient(meshUrl, apiKey);
      const folderName = path.basename(absFolder);
      const connectionUrl = `http://localhost:${LOCAL_DEV_PORT}/mcp`;

      const connResult = (await callMeshTool(
        client,
        "COLLECTION_CONNECTIONS_CREATE",
        {
          data: {
            title: folderName,
            connection_type: "HTTP",
            connection_url: connectionUrl,
          },
        },
      )) as { item: { id: string } };
      connectionId = connResult.item.id;
      step(`Connection created: ${folderName}`);

      // Create Project
      info("Creating project...");
      projectSlug = slugify(folderName);
      const decoSite = isDecoSite(absFolder);
      const enabledPlugins = decoSite ? ["site-editor"] : null;

      const projResult = (await callMeshTool(client, "PROJECT_CREATE", {
        organizationId: orgId,
        slug: projectSlug,
        name: folderName,
        enabledPlugins,
      })) as { project: { id: string } };
      projectId = projResult.project.id;
      step(`Project created: ${projectSlug}`);

      // Bind site-editor plugin to connection if deco site
      if (decoSite) {
        await callMeshTool(client, "PROJECT_PLUGIN_CONFIG_UPDATE", {
          projectId,
          pluginId: "site-editor",
          connectionId,
        });
        step("Site editor plugin enabled");
      }

      // Persist link state
      await writeLinkState(absFolder, {
        connectionId,
        projectId,
        projectSlug,
        meshUrl,
      });
    }

    // Print banner
    const projectUrl = `${meshUrl}/projects/${projectSlug}`;
    const folderName = path.basename(absFolder);
    console.log("");
    console.log(chalk.bold("  deco link"));
    console.log("");
    console.log(`  ${chalk.dim("Project:")}  ${folderName}`);
    console.log(`  ${chalk.dim("Mesh:")}     ${meshUrl}`);
    console.log(
      `  ${chalk.dim("local-dev:")} http://localhost:${LOCAL_DEV_PORT}`,
    );
    console.log(`  ${chalk.dim("URL:")}      ${projectUrl}`);
    console.log("");

    // Open browser
    openBrowser(projectUrl);
    info("Opening browser...");

    // Setup SIGINT/SIGTERM handler for clean shutdown
    let shuttingDown = false;
    const cleanup = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("");
      info("Shutting down...");
      stopLocalDev(localDevChild);
      step("local-dev stopped");
      step("Done");
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Keep alive — process stays running because local-dev child is attached
    console.log(chalk.dim("  Press Ctrl+C to stop\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail("deco link failed", message);
    stopLocalDev(localDevChild);
    process.exit(1);
  }
}
