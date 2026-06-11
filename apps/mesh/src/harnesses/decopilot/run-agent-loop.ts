/**
 * runAgentLoop — shared core for the decopilot harness.
 *
 * Owns: system-prompt assembly, tool assembly, streamText invocation,
 * prepareStep, error capture, OTel span for the loop itself.
 *
 * Does NOT own: HTTP plumbing, persistence, title generation, run-
 * registry registration (parent-wrapper concerns), nor target-agent
 * validation / MCP-client creation (subagent-wrapper concerns).
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import type { MeshProvider } from "@/ai-providers/types";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  stepCountIs,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
  type StreamTextOnStepFinishCallback,
  type UIMessageStreamWriter,
} from "ai";
import type { ModelsConfig } from "../types";
import type { ToolApprovalLevel } from "../../api/routes/decopilot/helpers";
import type { GithubRepo, UsageStats } from "@decocms/mesh-sdk";
import { createLanguageModel } from "../../ai-providers/language-model";
import { DEFAULT_MAX_TOKENS } from "./harness-constants";
import { PARENT_STEP_LIMIT, SUBAGENT_STEP_LIMIT } from "./prompt-constants";
import { buildAgentSystemPrompt } from "./build-agent-system-prompt";
import { assembleAgentTools } from "./assemble-agent-tools";
import type { SubtaskParams } from "./built-in-tools/subtask";
import type { ConnectionsBlockTool } from "./connections-block";
import {
  runNativeAgentLoopCore,
  type NativeAgentLoopCoreHandle,
} from "./native-agent-loop-core";

export interface RunAgentLoopOptions {
  ctx: StudioContext;
  organization: OrganizationScope;
  virtualMcp: {
    id: string;
    instructions?: string;
    repo?: GithubRepo;
  };
  mcpClient: Client;
  provider: MeshProvider;
  models: ModelsConfig;
  messages: ModelMessage[];
  systemAgentInstructions?: string;
  /** Current thread id — excluded from the user-context "history" recall. */
  currentThreadId?: string;
  kind: "agent" | "subagent";
  /** Authenticated user identity for the user-context prompt block. */
  user?: { id: string; name?: string | null; email?: string | null };
  /** Pre-resolved prompt data (threads/interests/agents) for the system prompt. */
  userContext?: import("../types").HarnessUserContext;
  stepLimit?: number;
  toolApprovalLevel?: ToolApprovalLevel;
  planMode?: boolean;
  temperature?: number;
  abortSignal: AbortSignal;
  tracer?: Tracer;
  writer: UIMessageStreamWriter;
  subtaskParams: SubtaskParams;
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
  onUsageAggregated?: (usage: UsageStats) => void;

  // ── Parent-supplied overrides ──────────────────────────────────────
  /** Optional override for the streamText prepareStep callback.
   *  Parent uses this for image injection + plan-mode filter + forced-
   *  first-step tool. Subagent doesn't pass one. */
  prepareStep?: unknown;
  /** Passthrough MCP client — when present, the system prompt's
   *  @-mention prompts block is populated via passthroughClient.listPrompts(). */
  passthroughClient?: Client;
  /** Connections data — when present, the system prompt's connections
   *  block is populated. */
  connectionsData?: {
    tools: ConnectionsBlockTool[];
    connectionTitleMap: Map<string, string>;
  };
  /** Extra tools to merge into the assembled toolset AFTER assembleAgentTools.
   *  Parent uses this to inject `enable_tool` (which is state-dependent —
   *  built from `enabledTools` reconstructed from message history). Subagents
   *  don't pass this. Merged last so parent extras shadow assembled tools. */
  extraTools?: ToolSet;
  /** Additional per-request system messages appended AFTER the stable system
   *  messages produced by buildAgentSystemPrompt. Parent uses this for
   *  `processedSystemMessages` (inline <system> blocks from the user's
   *  conversation that processConversation extracts). Subagents don't pass this. */
  additionalSystemMessages?: import("ai").SystemModelMessage[];

  /** When kind === "agent", controls which identity prompt is emitted:
   *  - true  → `buildDecopilotAgentPrompt()` (the decopilot identity)
   *  - false → no identity prompt; the agent's own instructions serve as identity
   *  Ignored when kind === "subagent". Defaults to false when absent. */
  isDecopilot?: boolean;

  // ── Stage 2: test-only shim (no production callers) ────────────────
  /** Override `streamText` for unit tests. Production paths leave undefined. */
  // biome-ignore lint/suspicious/noExplicitAny: test injection shim
  __streamText?: (...args: any[]) => any;
}

export interface RunAgentLoopHandle {
  result: NativeAgentLoopCoreHandle["result"];
  error: Promise<string | undefined>;
  span: Span;
  /** The system messages this loop assembled and sent to the model. Exposed so
   *  the parent (`runDecopilotStream`) can derive the `_request.systemSections`
   *  debug metadata from the REAL prompt — the single surviving assembler. */
  assembledSystemMessages: SystemModelMessage[];
}

export async function runAgentLoop(
  opts: RunAgentLoopOptions,
): Promise<RunAgentLoopHandle> {
  const tracer = opts.tracer ?? trace.getTracer("decopilot");
  const stepLimit =
    opts.stepLimit ??
    (opts.kind === "agent" ? PARENT_STEP_LIMIT : SUBAGENT_STEP_LIMIT);
  const planMode = opts.planMode ?? false;
  const toolApprovalLevel = opts.toolApprovalLevel ?? "auto";

  // ── OTel span ────────────────────────────────────────────────────
  const span = tracer.startSpan("decopilot.agent_loop", {
    attributes: {
      "decopilot.agent.id": opts.virtualMcp.id,
      "decopilot.agent.kind": opts.kind,
      "decopilot.organization.id": opts.organization.id,
      "decopilot.model.id": opts.models.thinking.id,
    },
  });

  // ── System prompt ─────────────────────────────────────────────────
  const baseSystemMessages = await buildAgentSystemPrompt({
    ctx: opts.ctx,
    organization: opts.organization,
    virtualMcp: opts.virtualMcp,
    kind: opts.kind,
    planMode,
    isDecopilot: opts.isDecopilot,
    agentInstructions: opts.systemAgentInstructions,
    currentThreadId: opts.currentThreadId,
    user: opts.user,
    userContext: opts.userContext,
    passthroughClient: opts.passthroughClient,
    connectionsData: opts.connectionsData,
  });
  // Append any per-request system messages (e.g., processedSystemMessages
  // from processConversation — inline <system> blocks in the conversation).
  const systemMessages =
    opts.additionalSystemMessages && opts.additionalSystemMessages.length > 0
      ? [...baseSystemMessages, ...opts.additionalSystemMessages]
      : baseSystemMessages;

  // ── Tools ─────────────────────────────────────────────────────────
  const { tools: assembledTools } = await assembleAgentTools({
    kind: opts.kind,
    ctx: opts.ctx,
    mcpClient: opts.mcpClient,
    writer: opts.writer,
    planMode,
    toolApprovalLevel,
    subtaskParams: opts.subtaskParams,
  });
  // Merge extra tools (e.g., parent's state-dependent `enable_tool`) after
  // the shared assembler. Parent extras shadow assembled tools intentionally.
  const tools: ToolSet = opts.extraTools
    ? { ...assembledTools, ...opts.extraTools }
    : assembledTools;

  // __streamText test shim bypasses real provider; model is only needed
  // for the real streamText path.
  const model = (opts as { __streamText?: unknown }).__streamText
    ? (undefined as never)
    : createLanguageModel(opts.provider, opts.models.thinking);

  const handle = runNativeAgentLoopCore({
    model,
    systemMessages,
    messages: opts.messages,
    tools,
    prepareStep: opts.prepareStep as never,
    temperature: opts.temperature,
    maxOutputTokens:
      opts.models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    stopWhen: stepCountIs(stepLimit),
    abortSignal: opts.abortSignal,
    onStepFinish: opts.onStepFinish,
    streamText: (opts as { __streamText?: typeof import("ai").streamText })
      .__streamText,
    onError: (message, error) => {
      console.error(
        `[runAgentLoop:${opts.kind}:${opts.virtualMcp.id}] Error`,
        message,
      );
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (error instanceof Error) span.recordException(error);
    },
  });

  Promise.resolve(handle.result.finishReason)
    .then(() => {
      span.setStatus({ code: SpanStatusCode.OK });
    })
    .finally(() => span.end());

  return {
    result: handle.result,
    error: handle.error,
    span,
    assembledSystemMessages: systemMessages,
  };
}
