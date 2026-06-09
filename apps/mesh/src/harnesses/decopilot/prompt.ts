/**
 * assembleDecopilotPrompt
 *
 * Builds the cached system-prompt block the decopilot harness hands to
 * `streamText`. Mirrors the inline assembly that lives in `stream-core.ts`
 * (~lines 690–761 and 955–959) and is responsible for:
 *  - Loading the org's other Virtual MCPs (for the `<available-agents>`
 *    delegation block) and the current MCP's prompt catalog (for the
 *    `<available-prompts>` block) in a single `Promise.all`.
 *  - Building each prompt fragment: base platform prompt, plan-mode
 *    prompt, web-search instructions (mode + tool-gated), repo
 *    environment prompt (when the VM is GitHub-linked), prompts block,
 *    agents block, connections block, todo_write guidance, and the
 *    per-agent identity (`Decopilot` vs the custom agent's
 *    server-provided instructions).
 *  - Filtering the parts array and wrapping it via `buildSystemMessages`
 *    so the Anthropic cache markers land on the last two parts and a
 *    non-cached `<current-context>` (date/time) is appended.
 * Today this code lives inline inside `stream-core.ts`; the helper here
 * is unused until Task 12 wires it through the harness factory.
 * Behavior is intended to be byte-for-byte the same as the inline
 * version, modulo the CLI-agent branch (claude-code / codex) which is
 * removed because the decopilot harness never runs against those
 * providers — they have their own harnesses.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { isDecopilot } from "@decocms/mesh-sdk";
import type { GithubRepo } from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  buildRepoEnvironmentPrompt,
  buildTodoWritePrompt,
} from "../../api/routes/decopilot/constants";
import { resolveModeConfig } from "../../api/routes/decopilot/mode-config";
import { buildAgentsBlock } from "./agents-block";
import { buildPromptsBlock, type PromptsBlockEntry } from "./prompts-block";
import {
  buildConnectionsBlock,
  type ConnectionsBlockTool,
} from "./connections-block";
import { buildSystemMessages, type SystemMessage } from "./system-prompt";
import type { HarnessStreamInput } from "../types";
import type { AssembledTools } from "./tools";

/**
 * listAgentsBlock — fetches the org's virtual MCPs and builds the
 * `<available-agents>` block. Excludes the current virtualMcpId if
 * provided. Returns null when no other active agents exist.
 */
export async function listAgentsBlock(
  ctx: StudioContext,
  org: OrganizationScope,
  currentVirtualMcpId?: string,
): Promise<string | null> {
  const virtualMcpList = await ctx.storage.virtualMcps.list(org.id);
  return buildAgentsBlock(
    virtualMcpList.map((vm) => ({
      id: vm.id,
      name: vm.title,
      description: vm.description,
      status: vm.status,
    })),
    currentVirtualMcpId ?? "",
  );
}

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

export interface AssembledPrompt {
  /** System messages ready to be merged with any per-request system
   *  messages (e.g. `processedSystemMessages` from `processConversation`)
   *  and passed to `streamText({ system: ... })`. Includes Anthropic
   *  cache markers on the last two stable parts plus a non-cached
   *  `<current-context>` (date/time) tail. */
  systemMessages: SystemMessage[];
}

/**
 * Build the decopilot system-prompt block for one streamText turn.
 *
 * Issues a single `listPrompts()` call on the passthrough MCP (for the
 * prompts block) and a single `ctx.storage.virtualMcps.list()` call (for
 * the agents block) — both in parallel. All other inputs come from
 * `input`, `ctx`, and `tools`.
 */
export async function assembleDecopilotPrompt(
  input: HarnessStreamInput,
  ctx: StudioContext,
  tools: AssembledTools,
): Promise<AssembledPrompt> {
  const organization = ctx.organization!;
  const modeConfig = resolveModeConfig(input.mode, { isCliAgent: false });

  // Build composable system prompt array
  const basePrompt = buildBasePlatformPrompt();

  const [virtualMcpList, promptList] = await Promise.all([
    ctx.storage.virtualMcps.list(organization.id),
    (async () => {
      const { prompts } = await tools.passthroughClient.listPrompts();
      return prompts;
    })(),
  ]);

  const agentsBlock = buildAgentsBlock(
    virtualMcpList.map((vm) => ({
      id: vm.id,
      name: vm.title,
      description: vm.description,
      status: vm.status,
    })),
    input.agent.id,
  );

  const promptsBlock = buildPromptsBlock(
    promptList.map((p) => ({
      name: p.name,
      description: p.description ?? null,
      arguments: (p.arguments ?? []).map((a) => ({
        name: a.name,
        required: a.required,
      })),
    })),
  );

  const connectionsBlock = buildConnectionsBlock(
    tools.connectionsBlockTools,
    tools.connectionTitleMap,
  );

  // Agent prompt: decopilot-specific or custom agent instructions
  const agentPrompt = isDecopilot(input.agent.id)
    ? buildDecopilotAgentPrompt()
    : tools.serverInstructions;

  const planModePrompt = modeConfig.planPrompt;

  const webSearchPrompt =
    modeConfig.webSearchInstructionPrompt && "web_search" in tools.tools
      ? modeConfig.webSearchInstructionPrompt
      : null;

  const vmMetadata = input.virtualMcp.metadata as {
    githubRepo?: GithubRepo | null;
  };
  const repoEnvironmentPrompt = vmMetadata?.githubRepo
    ? buildRepoEnvironmentPrompt(vmMetadata.githubRepo)
    : null;

  // The blocks are stable for the entire request, so we include
  // them in every step's system prompt — this keeps the prompt
  // prefix identical across steps and lets prompt caching kick in.
  const systemPrompts = [
    basePrompt,
    planModePrompt,
    webSearchPrompt,
    repoEnvironmentPrompt,
    promptsBlock,
    agentsBlock,
    connectionsBlock,
    buildTodoWritePrompt(),
    agentPrompt,
  ].filter((s): s is string => Boolean(s?.trim()));

  const systemMessages = buildSystemMessages(systemPrompts, new Date());

  return { systemMessages };
}
