/**
 * Studio autostart from cwd.
 *
 * If the cwd looks like a prepared MCP project (an `mcp/` subfolder, or the
 * cwd itself with the right shape), spawn its dev server, register it as a
 * Studio connection + agent, and surface a chat-with-agent URL so
 * `bunx decocms` lands the user directly in a working conversation.
 *
 * Best-effort: any failure logs and falls back to the normal Studio boot.
 */

import { randomUUID } from "node:crypto";
import { addLogEntry, setAutostartProject } from "../cli-store";
import { getDb } from "../../database";
import { getLocalAdminUser, isLocalMode } from "../../auth/local-mode";
import { CredentialVault } from "../../encryption/credential-vault";
import { getSettings } from "../../settings";
import { ConnectionStorage } from "../../storage/connection";
import { VirtualMCPStorage } from "../../storage/virtual";
import { fetchToolsFromMCP } from "../../tools/connection/fetch-tools";
import type { ToolDefinition } from "../../tools/connection/schema";
import { detectProject } from "./detect";
import { startMcpDevServer, type SpawnedDevServer } from "./spawn";
import { draftSystemPrompt } from "./prompt";
import { resolve as resolvePath } from "node:path";
import {
  autostartConnectionId,
  registerProjectAsAgent,
  type AutostartLayout,
  type PinnedView,
} from "./register";

/**
 * Read a tool's UI resource URI from `_meta` — same shape ext-apps' SDK uses.
 * A tool with a UI sets `_meta.ui.resourceUri = "ui://…"` (or the legacy
 * `_meta["ui/resourceUri"]`).
 */
function getToolUiResourceUri(tool: ToolDefinition): string | null {
  const meta = tool._meta as Record<string, unknown> | null | undefined;
  if (!meta) return null;
  const fromUi = (meta.ui as { resourceUri?: unknown } | undefined)
    ?.resourceUri;
  const fromLegacy = meta["ui/resourceUri"];
  const candidate = fromUi ?? fromLegacy;
  return typeof candidate === "string" && candidate.startsWith("ui://")
    ? candidate
    : null;
}

function buildPinnedViewsAndLayout(
  connectionId: string,
  tools: ToolDefinition[],
): { pinnedViews: PinnedView[]; layout: AutostartLayout } {
  const uiTools = tools.filter((t) => getToolUiResourceUri(t));
  const pinnedViews: PinnedView[] = uiTools.map((t) => ({
    connectionId,
    toolName: t.name,
    label: t.title || t.annotations?.title || t.name,
    icon: null,
  }));
  const first = uiTools[0];
  const layout: AutostartLayout = first
    ? {
        defaultMainView: {
          type: "ext-apps",
          id: connectionId,
          toolName: first.name,
        },
        chatDefaultOpen: true,
      }
    : {};
  return { pinnedViews, layout };
}

export interface AutostartOptions {
  cwd: string;
  /** Studio's port (so we can build the chat URL on the right host). */
  studioPort: number;
  /** Studio's base URL (overrides http://localhost:<port>). */
  studioBaseUrl?: string;
  /** When false, do not open the chat URL in the user's browser. */
  open?: boolean;
}

/** Tracks every child we spawned so graceful shutdown can stop them. */
const _children: SpawnedDevServer[] = [];

export function getAutostartChildren(): readonly SpawnedDevServer[] {
  return _children;
}

function log(line: string) {
  addLogEntry({
    method: "",
    path: "",
    status: 0,
    duration: 0,
    timestamp: new Date(),
    rawLine: line,
  });
}

function openBrowser(url: string): void {
  try {
    if (!process.stdout.isTTY) return;
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // ignore — user has the URL printed
  }
}

async function resolveOrg(
  db: ReturnType<typeof getDb>["db"],
  userId: string,
): Promise<{ id: string; slug: string } | null> {
  const member = await db
    .selectFrom("member")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .select(["organization.id as id", "organization.slug as slug"])
    .where("member.userId", "=", userId)
    .executeTakeFirst();
  if (!member?.id) return null;
  return { id: member.id, slug: member.slug ?? member.id };
}

export async function maybeAutostartFromCwd(
  options: AutostartOptions,
): Promise<void> {
  const { cwd, studioPort, studioBaseUrl, open = true } = options;

  if (!isLocalMode()) {
    // Autostart relies on the local-mode admin/org; in cloud/multi-tenant
    // mode we don't have a single user identity to attach the agent to.
    return;
  }

  const project = detectProject(cwd);
  if (!project) {
    return;
  }

  setAutostartProject({
    name: project.name,
    status: "starting",
    chatUrl: null,
  });
  log(`[autostart] detected MCP project at ${project.root}`);

  let spawned: SpawnedDevServer | null = null;
  try {
    spawned = await startMcpDevServer(project);
    _children.push(spawned);
    log(`[autostart] ${project.name} listening at ${spawned.mcpUrl}`);

    const { db } = getDb();
    const adminUser = await getLocalAdminUser();
    if (!adminUser?.id) {
      throw new Error("local admin user not found — seed not complete");
    }
    const org = await resolveOrg(db, adminUser.id);
    if (!org) {
      throw new Error("no organization found for local admin");
    }

    const fetchResult = await fetchToolsFromMCP({
      id: "autostart-probe",
      title: project.name,
      connection_type: "HTTP",
      connection_url: spawned.mcpUrl,
      connection_token: null,
      connection_headers: null,
    }).catch(() => null);
    const tools: ToolDefinition[] = fetchResult?.tools ?? [];
    log(`[autostart] fetched ${tools.length} tool(s) from ${project.name}`);

    const drafted = await draftSystemPrompt({
      db,
      organizationId: org.id,
      project,
      tools,
    });
    log(`[autostart] system prompt source=${drafted.source}`);

    const vault = new CredentialVault(getSettings().encryptionKey);
    const connId = autostartConnectionId(resolvePath(project.root));
    const { pinnedViews, layout } = buildPinnedViewsAndLayout(connId, tools);
    log(
      `[autostart] ${pinnedViews.length} UI tool(s) detected${
        pinnedViews.length > 0 ? ` (default: ${pinnedViews[0]!.label})` : ""
      }`,
    );

    const { connectionId, virtualMcpId, isNew } = await registerProjectAsAgent({
      connections: new ConnectionStorage(db, vault),
      virtualMcps: new VirtualMCPStorage(db),
      organizationId: org.id,
      userId: adminUser.id,
      project,
      mcpUrl: spawned.mcpUrl,
      instructions: drafted.prompt,
      pinnedViews,
      layout,
    });
    log(
      `[autostart] ${isNew ? "registered" : "refreshed"} agent vir=${virtualMcpId} conn=${connectionId}`,
    );

    const baseUrl = studioBaseUrl ?? `http://localhost:${studioPort}`;
    const taskId = randomUUID();
    const chatUrl = `${baseUrl}/${org.slug}/${taskId}?virtualmcpid=${virtualMcpId}`;

    setAutostartProject({
      name: project.name,
      status: "ready",
      chatUrl,
    });
    log(`[autostart] open: ${chatUrl}`);

    if (open) openBrowser(chatUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[autostart] failed: ${msg}`);
    setAutostartProject({
      name: project.name,
      status: "failed",
      chatUrl: null,
      error: msg,
    });
    if (spawned) spawned.kill();
  }
}
