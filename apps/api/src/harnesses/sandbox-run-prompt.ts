/**
 * What a sandbox-hosted run's system-prompt append carries beyond the agent's
 * own instructions: the per-user context Decopilot renders into its system
 * prompt, and the chat mode the user picked for this message.
 */

import { agentsCatalog } from "@/harnesses/lib/decopilot/agents-block";
import type { ChatMode } from "@/harnesses/lib/decopilot/mode-config";
import { renderUserContextBlock } from "@/harnesses/lib/decopilot/user-context-block";
import type { HarnessUserContext } from "@/harnesses/lib/types";

const MODE_TOOLS: Partial<Record<ChatMode, { label: string; tool: string }>> = {
  "gen-image": { label: "image generation", tool: "generate_image" },
  "web-search": { label: "web search", tool: "web_search" },
  "deep-research": { label: "deep research", tool: "deep_research" },
};

/** The line that turns a mode pill into a tool call, or null for other modes. */
export function modeInstruction(mode: ChatMode): string | null {
  const entry = MODE_TOOLS[mode];
  if (!entry) return null;
  return (
    `The user turned on ${entry.label} for this message: answer it by calling ` +
    `the \`${entry.tool}\` tool from the \`studio\` MCP server.`
  );
}

export function sandboxRunPrompt(args: {
  mode: ChatMode;
  threadId: string;
  agentId: string;
  userEmail: string | undefined;
  userContext: HarnessUserContext;
}): string {
  const otherAgents = (args.userContext.agents ?? []).filter(
    (agent) => agent.id !== args.agentId && agent.status === "active",
  );
  return [
    renderUserContextBlock({
      user: { email: args.userEmail },
      currentThreadId: args.threadId,
      userContext: args.userContext,
    }),
    agentsCatalog(otherAgents),
    modeInstruction(args.mode),
  ]
    .filter(Boolean)
    .join("\n\n");
}
