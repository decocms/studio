/**
 * Registers a detected & spawned MCP project as a Studio connection + agent
 * (Virtual MCP) in-process, against the running server's database.
 *
 * Idempotency: IDs are deterministic from a hash of the absolute project path,
 * so re-running `bunx decocms` in the same folder reuses the existing
 * connection/agent (just refreshes the URL if the port changed).
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ConnectionStorage } from "../../storage/connection";
import type { VirtualMCPStorage } from "../../storage/virtual";
import type { DetectedProject } from "./detect";

export interface PinnedView {
  connectionId: string;
  toolName: string;
  label: string;
  icon: string | null;
}

export interface AutostartLayout {
  defaultMainView?: {
    type: string;
    id?: string;
    toolName?: string;
  } | null;
  chatDefaultOpen?: boolean | null;
}

export interface RegisterParams {
  connections: ConnectionStorage;
  virtualMcps: VirtualMCPStorage;
  organizationId: string;
  userId: string;
  project: DetectedProject;
  /** The HTTP MCP endpoint we're spawning (full URL, e.g. http://localhost:3001/mcp). */
  mcpUrl: string;
  /** Drafted system prompt (template fallback or LLM-generated). */
  instructions: string;
  /** Optional pinned views (one per UI-bearing tool). */
  pinnedViews?: PinnedView[];
  /** Optional layout (defaultMainView + chatDefaultOpen). */
  layout?: AutostartLayout;
}

export interface RegisterResult {
  connectionId: string;
  virtualMcpId: string;
  isNew: boolean;
}

/**
 * Hash an absolute path → 12-char hex slug. Stable across re-runs.
 */
export function pathSlug(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

export function autostartConnectionId(absPath: string): string {
  return `conn_auto_${pathSlug(absPath)}`;
}

export function autostartVirtualMcpId(absPath: string): string {
  return `vir_auto_${pathSlug(absPath)}`;
}

export async function registerProjectAsAgent(
  params: RegisterParams,
): Promise<RegisterResult> {
  const {
    connections,
    virtualMcps,
    organizationId,
    userId,
    project,
    mcpUrl,
    instructions,
    pinnedViews,
    layout,
  } = params;

  const absRoot = resolve(project.root);
  const connectionId = autostartConnectionId(absRoot);
  const virtualMcpId = autostartVirtualMcpId(absRoot);

  // detect.ts already resolves description (pkg.description → first README
  // paragraph). Use it as-is.
  const description = project.description;

  const existingConnection = await connections.findById(
    connectionId,
    organizationId,
  );

  let isNew = false;
  if (existingConnection) {
    // Refresh URL in case the port changed (port is dynamic per run).
    if (existingConnection.connection_url !== mcpUrl) {
      await connections.update(connectionId, {
        connection_url: mcpUrl,
        updated_by: userId,
      });
    }
  } else {
    isNew = true;
    await connections.create({
      id: connectionId,
      organization_id: organizationId,
      created_by: userId,
      title: project.name,
      description,
      icon: null,
      connection_type: "HTTP",
      connection_url: mcpUrl,
      connection_token: null,
      connection_headers: null,
      oauth_config: null,
      configuration_state: null,
      configuration_scopes: null,
      metadata: { autostart: { source: resolve(project.root) } },
      bindings: null,
    });
  }

  const existingAgent = await virtualMcps.findById(
    virtualMcpId,
    organizationId,
  );

  if (existingAgent) {
    // Update instructions only if user hasn't customized them (no metadata
    // marker), or if --reprompt was passed (caller decides by passing fresh
    // instructions; the existing flow doesn't differentiate, so always
    // refresh on re-runs is too aggressive — keep the existing instructions
    // unless the agent has the autostart marker AND no user edit).
    const meta = (existingAgent.metadata ?? {}) as Record<string, unknown>;
    const isAutostartManaged = Boolean(
      (meta.autostart as { source?: string } | undefined)?.source,
    );
    const hasInstructions = Boolean(meta.instructions);
    if (isAutostartManaged && !hasInstructions) {
      await virtualMcps.update(virtualMcpId, userId, {
        metadata: { ...meta, instructions },
      });
    }
  } else {
    isNew = true;
    const ui =
      pinnedViews && pinnedViews.length > 0
        ? { pinnedViews, layout: layout ?? null }
        : layout
          ? { pinnedViews: null, layout }
          : null;
    await virtualMcps.create(
      organizationId,
      userId,
      {
        title: project.name,
        description,
        status: "active",
        pinned: true,
        connections: [{ connection_id: connectionId }],
        metadata: {
          instructions,
          autostart: { source: resolve(project.root) },
          ...(ui ? { ui } : {}),
        },
      },
      { id: virtualMcpId },
    );
  }

  return { connectionId, virtualMcpId, isNew };
}
