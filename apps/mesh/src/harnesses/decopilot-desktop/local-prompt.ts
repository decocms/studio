/**
 * local-prompt — minimal system-prompt assembly for the desktop harness.
 *
 * Shared prompt builders live in `harnesses/decopilot/prompt-constants.ts`.
 * This module only assembles the desktop-specific prompt shape.
 *
 * `buildDesktopPrompt` assembles the minimal prompt:
 *   base platform + connections block + todo-write guidance + agent identity.
 * It deliberately SKIPS the cluster-only blocks that need `ctx.storage`
 * (agents block via `virtualMcps.list`) or studio-pack resolution. Cache
 * markers + the per-request current-context tail come from the portable
 * `system-prompt` leaf (reused by relative path).
 */

import {
  buildConnectionsBlock,
  type ConnectionsBlockTool,
} from "../decopilot/connections-block";
import {
  buildSystemMessages,
  type SystemMessage,
} from "../decopilot/system-prompt";
export { PARENT_STEP_LIMIT } from "../decopilot/prompt-constants";
import {
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  buildTodoWritePrompt,
} from "../decopilot/prompt-constants";

export interface DesktopPromptInput {
  /** Active agent (virtual MCP) id — used to decide whether the decopilot
   *  identity prompt is emitted. */
  agentId: string;
  /** True when the active agent is the well-known decopilot agent. */
  isDecopilotAgent: boolean;
  /** Connections-block tool list (built from the passthrough MCP listing). */
  connectionsBlockTools: ConnectionsBlockTool[];
  /** connectionId → human title map (best-effort; may be empty on desktop). */
  connectionTitleMap: Map<string, string>;
  /** The active agent's own instructions, when it is NOT decopilot. */
  agentInstructions?: string;
  /** Plan-mode prompt fragment, when mode === "plan". */
  planPrompt?: string | null;
  /** Web-search behaviour hint, when mode === "web-search". */
  webSearchPrompt?: string | null;
}

/**
 * Build the minimal desktop system prompt. Mirrors the cluster's prompt
 * ordering for the blocks the desktop can produce, dropping the ones that
 * require cluster storage (agents block) or studio-pack resolution.
 */
export function buildDesktopPrompt(input: DesktopPromptInput): {
  systemMessages: SystemMessage[];
} {
  const basePrompt = buildBasePlatformPrompt();
  const connectionsBlock = buildConnectionsBlock(
    input.connectionsBlockTools,
    input.connectionTitleMap,
  );
  const agentPrompt = input.isDecopilotAgent
    ? buildDecopilotAgentPrompt()
    : input.agentInstructions;

  const parts = [
    basePrompt,
    input.planPrompt,
    connectionsBlock,
    buildTodoWritePrompt(),
    input.webSearchPrompt,
    agentPrompt,
  ].filter((s): s is string => Boolean(s?.trim()));

  return { systemMessages: buildSystemMessages(parts, new Date()) };
}
