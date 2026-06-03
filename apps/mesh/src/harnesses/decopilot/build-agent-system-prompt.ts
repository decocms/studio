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

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
import {
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  buildTodoWritePrompt,
  buildRepoEnvironmentPrompt,
} from "../../api/routes/decopilot/constants";
import type { GithubRepo } from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildSystemMessages, type SystemMessage } from "./system-prompt";
import {
  listPromptsBlock,
  listAgentsBlock,
  listConnectionsBlock,
} from "./prompt";
import type { ConnectionsBlockTool } from "./connections-block";
import type { Interest } from "@/storage/interests";
import type { Thread } from "@/storage/types";

const MAX_INJECTED_INTERESTS = 3;

/** Absolute date label (YYYY-MM-DD) — request-stable so the cached system
 *  prefix isn't invalidated each turn the way a relative "3 mins ago" would be.
 *  The model derives recency from the separate <current-context> date. */
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "unknown date"
    : d.toISOString().slice(0, 10);
}

function renderInterestsSection(interests: Interest[]): string {
  const lines = interests.map((i) => `- ${i.title}: ${i.summary}`);
  return `### What they're working toward

Most important first:

${lines.join("\n")}

When the conversation is open-ended or clearly related, gently surface one concrete next step toward these. Do NOT derail a focused task the user is already on, and never force an interest in when it isn't relevant.`;
}

function renderRecentThreadsSection(total: number, threads: Thread[]): string {
  const lines = threads.map(
    (t) => `- "${t.title}" (${dateLabel(t.updated_at as string)})`,
  );
  return `### Your history together

You and this user have had ${total} previous conversation${total === 1 ? "" : "s"}. Most recent:

${lines.join("\n")}

Don't recap these unprompted, but use them so you recognize the user and pick up context naturally instead of treating them as a stranger.`;
}

/**
 * Build the per-user context block — who they are, your shared history, and
 * what they're working toward. Returns null when there's nothing to say.
 * Only top-level agents get this; subagents are task-scoped.
 */
async function buildUserContextBlock(
  opts: BuildAgentSystemPromptOptions,
): Promise<string | null> {
  if (opts.kind !== "agent") return null;
  const user = opts.ctx.auth?.user;
  const userId = user?.id;
  if (!userId) return null;
  const agentId = opts.virtualMcp.id;

  const sections: string[] = [];

  // Identity — from the authenticated session.
  if (user.name || user.email) {
    const name = user.name ?? user.email;
    const email = user.name && user.email ? ` (${user.email})` : "";
    sections.push(`### Who you're talking to

You're talking to ${name}${email}. Address them by name when it's natural.`);
  }

  // Continuity + interests are independent reads — fetch in parallel so the
  // prompt build doesn't pay two serial round-trips.
  const [recent, doc] = await Promise.all([
    opts.ctx.storage?.threads
      ?.list(userId, { limit: 9, agentId })
      .catch(() => null),
    opts.ctx.storage?.interests
      ?.getForAgent(opts.organization.id, agentId, userId)
      .catch(() => null),
  ]);

  // Continuity — recent threads with THIS agent, excluding the current one.
  if (recent && recent.total > 0) {
    const others = recent.threads
      .filter((t) => t.id !== opts.currentThreadId)
      .slice(0, 8);
    if (others.length > 0) {
      // The current thread is always part of the user's total, so exclude it
      // from the count whenever we know which one it is.
      const total = opts.currentThreadId ? recent.total - 1 : recent.total;
      if (total > 0) {
        sections.push(renderRecentThreadsSection(total, others));
      }
    }
  }

  // Interests — durable goals, scoped to this agent.
  if (doc && doc.interests.length > 0) {
    sections.push(
      renderInterestsSection(doc.interests.slice(0, MAX_INJECTED_INTERESTS)),
    );
  }

  sections.push(
    "When you learn a durable new goal the user is working toward — or clear progress on an existing one — call `update_interests` to keep this record current. Skip one-off questions.",
  );

  // Only the closing instruction with no identity/history/interests above it
  // isn't worth a block of its own.
  if (sections.length <= 1) return null;
  return `## About this user\n\n${sections.join("\n\n")}`;
}

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
  ctx: MeshContext;
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

  prompts.push(buildBasePlatformPrompt());

  if (opts.kind === "agent" && opts.planMode) {
    // Re-use the plan-mode prompt from mode-config (non-CLI variant).
    const { resolveModeConfig } = await import(
      "../../api/routes/decopilot/mode-config"
    );
    const modeConfig = resolveModeConfig("plan", { isCliAgent: false });
    if (modeConfig.planPrompt) {
      prompts.push(modeConfig.planPrompt);
    }
  }

  if (opts.virtualMcp.repo) {
    prompts.push(buildRepoEnvironmentPrompt(opts.virtualMcp.repo));
  }

  if (opts.kind === "agent") {
    if (opts.isDecopilot) {
      prompts.push(buildDecopilotAgentPrompt());
    }
    // For custom agents (kind: "agent" && !isDecopilot), no identity
    // prompt — the agent's own instructions (via agentInstructions
    // param) serve as identity.
  } else {
    prompts.push(SUBAGENT_IDENTITY_PROMPT);
  }

  const promptsBlock = await listPromptsBlock(
    opts.ctx,
    opts.organization,
    opts.passthroughClient,
  );
  if (promptsBlock) prompts.push(promptsBlock);

  if (opts.kind === "agent") {
    const agentsBlock = await listAgentsBlock(
      opts.ctx,
      opts.organization,
      opts.virtualMcp.id,
    );
    if (agentsBlock) prompts.push(agentsBlock);
  }

  const connectionsBlock = await listConnectionsBlock(
    opts.ctx,
    opts.organization,
    opts.connectionsData,
  );
  if (connectionsBlock) prompts.push(connectionsBlock);

  prompts.push(buildTodoWritePrompt());

  if (opts.agentInstructions?.trim()) {
    prompts.push(opts.agentInstructions);
  }

  const userContextBlock = await buildUserContextBlock(opts);
  if (userContextBlock) prompts.push(userContextBlock);

  return buildSystemMessages(prompts, opts.date ?? new Date());
}
