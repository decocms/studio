/**
 * Decopilot system-prompt block helpers.
 *
 * The shared Decopilot core's ONE prompt assembler is
 * `buildAgentSystemPrompt` (`./build-agent-system-prompt`), invoked inside the
 * engine (`runAgentLoop`). It consumes the `list*Block` helpers below.
 * (The `<available-agents>` block is now pre-resolved agent-side as data and
 * rendered via `buildAgentsBlock`, so no storage-coupled helper lives here.)
 *
 * The previous standalone `assembleDecopilotPrompt` was a DUPLICATE assembler
 * whose output fed only the `_request.systemSections` debug metadata while the
 * real prompt was built by `buildAgentSystemPrompt`. The core now derives that
 * debug metadata from the engine's real assembled prompt
 * (`AssembledEngineHandle.assembledSystemMessages`), so the duplicate is gone.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildPromptsBlock,
  type PromptsBlockEntry,
} from "@/harnesses/lib/decopilot/prompts-block";
import {
  buildConnectionsBlock,
  type ConnectionsBlockTool,
} from "@/harnesses/lib/decopilot/connections-block";

/**
 * listPromptsBlock — fetches the MCP's prompt catalog via the passthrough
 * client and builds the `<available-prompts>` block. Returns null when no
 * client is provided (e.g., unit tests) or when the catalog is empty.
 */
export async function listPromptsBlock(
  _ctx: StudioContext,
  _org: OrganizationScope,
  passthroughClient?: Client,
): Promise<string | null> {
  if (!passthroughClient) return null;
  try {
    const { prompts } = await passthroughClient.listPrompts();
    if (!prompts?.length) return null;
    return buildPromptsBlock(
      prompts.map((p) => ({
        name: p.name,
        description: p.description ?? null,
        arguments: (p.arguments ?? []).map((a) => ({
          name: a.name,
          required: a.required,
        })),
      })) satisfies PromptsBlockEntry[],
    );
  } catch (err) {
    console.warn("[listPromptsBlock] Failed to list prompts:", err);
    return null;
  }
}

/**
 * listConnectionsBlock — builds the `<available-connections>` block from
 * pre-assembled tools data. Returns null when no data is provided or when
 * there are no tools to expose.
 */
export async function listConnectionsBlock(
  _ctx: StudioContext,
  _org: OrganizationScope,
  data?: {
    tools: ConnectionsBlockTool[];
    connectionTitleMap: Map<string, string>;
  },
): Promise<string | null> {
  if (!data || data.tools.length === 0) return null;
  return buildConnectionsBlock(data.tools, data.connectionTitleMap);
}
