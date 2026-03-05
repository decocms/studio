import { generatePrefixedId } from "@/shared/utils/generate-id";
import type { ChatMessage } from "./types";

/** Message ID generator. Use as closure where a () => string is expected (e.g. toUIMessageStreamResponse). */
export const generateMessageId = () => generatePrefixedId("msg");

export const DEFAULT_MAX_TOKENS = 32768;
export const DEFAULT_WINDOW_SIZE = 50;
export const DEFAULT_THREAD_TITLE = "New chat";

export const PARENT_STEP_LIMIT = 30;
export const SUBAGENT_STEP_LIMIT = 15;
export const SUBAGENT_EXCLUDED_TOOLS = ["user_ask", "subtask"];

/**
 * Base system prompt for Decopilot
 *
 * @param agentInstructions - Optional instructions specific to the selected agent/virtual MCP
 * @returns ChatMessage with the base system prompt
 */
export function DECOPILOT_BASE_PROMPT(agentInstructions?: string): ChatMessage {
  const platformPrompt = `You are decopilot, an AI assistant running inside decocms (deco context management system).`;

  let text = platformPrompt;
  if (agentInstructions?.trim()) {
    text += `

---

## Agent-Specific Instructions

The following instructions are specific to the agent (virtual MCP) the user has selected. These instructions supplement the platform guidelines above:

${agentInstructions}`;
  }

  return {
    id: "decopilot-system",
    role: "system",
    parts: [{ type: "text", text }],
  };
}

export const TITLE_GENERATOR_PROMPT = `Your task: Generate a short title (3-6 words) summarizing the user's request.

Rules:
- Output ONLY the title, nothing else
- No quotes, no punctuation at the end
- No explanations, no "Title:" prefix
- Just the raw title text

Example input: "How do I connect to a database?"
Example output: Database Connection Setup

Example input: "What tools are available?"
Example output: Available Tools Overview`;
