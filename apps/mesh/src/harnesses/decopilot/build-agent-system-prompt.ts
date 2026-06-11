/**
 * buildAgentSystemPrompt — shared system-prompt assembler for both
 * parent agents and subagents in the decopilot harness.
 *
 * The `kind` discriminator drives:
 *   - which identity prompt is used (decopilot vs subagent)
 *   - whether the agents block is included
 *   - whether the plan-mode prompt is included (subagent never gets it)
 *
 * Everything else (base platform, repo env, prompts block, connections
 * block, todo_write guidance, agent instructions) is included for BOTH
 * kinds — though in Stage 2.1 listPromptsBlock and listConnectionsBlock
 * are stubs returning null (wired up fully in Stage 2.3).
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import {
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  buildTodoWritePrompt,
  buildRepoEnvironmentPrompt,
} from "./prompt-constants";
import type { GithubRepo } from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildSystemMessages, type SystemMessage } from "./system-prompt";
import { listPromptsBlock, listConnectionsBlock } from "./prompt";
import { buildAgentsBlock } from "./agents-block";
import { renderUserContextBlock } from "./user-context-block";
import type { ConnectionsBlockTool } from "./connections-block";
import type { HarnessUserContext } from "../types";

const SUBAGENT_IDENTITY_PROMPT = `You are a focused subtask agent delegated a specific task by a parent agent. You are NOT the parent agent.

## Rules (non-negotiable)

1. Do NOT converse, ask questions, or suggest next steps to the user — you cannot interact with them.
2. Do NOT delegate to other agents — execute directly.
3. Stay strictly within your task's scope. If you discover related work outside your scope, mention it in one sentence at most.

## Before Acting: Assess the Task

Before making ANY tool calls, evaluate: do you understand what to do, how to do it, and when you're done?

- **If unclear** → Respond IMMEDIATELY with what's missing. Make zero tool calls. The parent agent will reformulate with more context.
- **If clear** → Proceed autonomously. Be efficient, be thorough, don't second-guess. If you hit obstacles mid-execution, make reasonable judgment calls and note them.

## Execution

- Use your tools directly. Do not emit text between tool calls — use tools, then report once at the end.
- Keep your report under 500 words unless the task requires more detail. Be factual and concise.
- Do not use emojis.

## When Done: Report

End with a structured summary:
- **Result**: What you did, what you found or produced
- **Key files**: Relevant file paths (always absolute, never relative) — include only for research tasks
- **Issues**: Anything to flag — include only if there are issues

This report is all the parent agent sees.`;

export interface BuildAgentSystemPromptOptions {
  ctx: StudioContext;
  organization: OrganizationScope;
  virtualMcp: {
    id: string;
    instructions?: string;
    repo?: GithubRepo;
  };
  kind: "agent" | "subagent";
  planMode: boolean;
  /**
   * When `kind === "agent"`, controls which identity prompt is emitted:
   * - true  → `buildDecopilotAgentPrompt()` (the decopilot identity)
   * - false → no identity prompt; the agent's own `agentInstructions` serve as identity
   *
   * Ignored when `kind === "subagent"` (always uses `SUBAGENT_IDENTITY_PROMPT`).
   * Defaults to false when absent.
   */
  isDecopilot?: boolean;
  agentInstructions?: string;
  date?: Date;
  /** Current thread id, excluded from the "history together" recall so the
   *  agent doesn't "remember" the conversation it's currently in. */
  currentThreadId?: string;
  /** Authenticated user identity, for the user-context block. Replaces the
   *  prior `ctx.auth.user` read. Absent ⇒ no identity section. */
  user?: { id: string; name?: string | null; email?: string | null };
  /** Pre-resolved prompt data (threads/interests/agents). Read agent-side
   *  before dispatch. Absent sub-blocks are skipped. */
  userContext?: HarnessUserContext;

  // ── Optional runtime data ──────────────────────────────────────────
  // When provided, the prompts and connections blocks get included.
  // When absent (e.g., unit tests with no live MCP), the blocks are
  // omitted gracefully — the caller is responsible for supplying these
  // when they want subagents/agents to see the full context.
  passthroughClient?: Client;
  connectionsData?: {
    tools: ConnectionsBlockTool[];
    connectionTitleMap: Map<string, string>;
  };
}

export async function buildAgentSystemPrompt(
  opts: BuildAgentSystemPromptOptions,
): Promise<SystemMessage[]> {
  const prompts: string[] = [];
  const labels: string[] = [];
  const add = (label: string, text: string | null | undefined) => {
    if (!text?.trim()) return;
    prompts.push(text);
    labels.push(label);
  };

  add("base", buildBasePlatformPrompt());

  if (opts.kind === "agent" && opts.planMode) {
    // Re-use the plan-mode prompt from mode-config (non-CLI variant).
    const { resolveModeConfig } = await import("./mode-config");
    const modeConfig = resolveModeConfig("plan", { isCliAgent: false });
    add("planMode", modeConfig.planPrompt);
  }

  if (opts.virtualMcp.repo) {
    add("repoEnv", buildRepoEnvironmentPrompt(opts.virtualMcp.repo));
  }

  if (opts.kind === "agent") {
    if (opts.isDecopilot) {
      add("identity", buildDecopilotAgentPrompt());
    }
    // For custom agents (kind: "agent" && !isDecopilot), no identity
    // prompt — the agent's own instructions (via agentInstructions
    // param) serve as identity.
  } else {
    add("identity", SUBAGENT_IDENTITY_PROMPT);
  }

  add(
    "prompts",
    await listPromptsBlock(opts.ctx, opts.organization, opts.passthroughClient),
  );

  if (opts.kind === "agent" && opts.userContext?.agents) {
    add(
      "agents",
      buildAgentsBlock(opts.userContext.agents, opts.virtualMcp.id),
    );
  }

  add(
    "connections",
    await listConnectionsBlock(
      opts.ctx,
      opts.organization,
      opts.connectionsData,
    ),
  );

  add("todoWrite", buildTodoWritePrompt());

  add("agentInstructions", opts.agentInstructions);

  if (opts.kind === "agent" && opts.user) {
    add(
      "userContext",
      renderUserContextBlock({
        user: opts.user,
        currentThreadId: opts.currentThreadId,
        userContext: opts.userContext ?? {},
      }),
    );
  }

  return buildSystemMessages(prompts, opts.date ?? new Date());
}
