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

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
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
  streamText,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type StreamTextOnStepFinishCallback,
  type UIMessageStreamWriter,
} from "ai";
import type { ModelsConfig } from "../../api/routes/decopilot/types";
import type { ToolApprovalLevel } from "../../api/routes/decopilot/helpers";
import type { GithubRepo, UsageStats } from "@decocms/mesh-sdk";
import { OPENROUTER_CACHE_PROVIDER_OPTIONS } from "../../api/routes/decopilot/cache-instrumentation";
import { createLanguageModel } from "../../ai-providers/language-model";
import {
  DEFAULT_MAX_TOKENS,
  PARENT_STEP_LIMIT,
  SUBAGENT_STEP_LIMIT,
} from "../../api/routes/decopilot/constants";
import { buildAgentSystemPrompt } from "./build-agent-system-prompt";
import { assembleAgentTools } from "./assemble-agent-tools";
import type { SubtaskParams } from "./built-in-tools/subtask";
import type { ConnectionsBlockTool } from "./connections-block";

export interface RunAgentLoopOptions {
  ctx: MeshContext;
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
  kind: "agent" | "subagent";
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
  result: StreamTextResult<ToolSet, never>;
  error: Promise<string | undefined>;
  span: Span;
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

  // ── Error capture: a single promise resolved by onError/onAbort ──
  let capturedError: string | undefined;
  let resolveError!: (err: string | undefined) => void;
  const errorPromise = new Promise<string | undefined>((resolve) => {
    resolveError = resolve;
  });
  const finalizeError = (err: string | undefined) => {
    if (capturedError === undefined) capturedError = err;
    resolveError(capturedError);
  };

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

  // ── streamText (use shim if provided, else real) ──────────────────
  const streamTextFn =
    (opts as { __streamText?: unknown }).__streamText ?? streamText;
  // __streamText test shim bypasses real provider; model is only needed
  // for the real streamText path.
  const model = (opts as { __streamText?: unknown }).__streamText
    ? (undefined as never)
    : createLanguageModel(opts.provider, opts.models.thinking);

  const result = (streamTextFn as typeof streamText)({
    model,
    system: systemMessages,
    messages: opts.messages,
    tools,
    providerOptions: OPENROUTER_CACHE_PROVIDER_OPTIONS,
    prepareStep: opts.prepareStep as never,
    temperature: opts.temperature,
    maxOutputTokens:
      opts.models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    stopWhen: stepCountIs(stepLimit),
    abortSignal: opts.abortSignal,
    onStepFinish: opts.onStepFinish,
    onError: async (event: { error?: unknown }) => {
      const error = event.error ?? event;
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : `${error}`;
      console.error(
        `[runAgentLoop:${opts.kind}:${opts.virtualMcp.id}] Error`,
        error,
      );
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (error instanceof Error) span.recordException(error);
      finalizeError(message);
    },
    onAbort: async () => {
      console.error(
        `[runAgentLoop:${opts.kind}:${opts.virtualMcp.id}] Aborted`,
      );
      finalizeError(capturedError ?? "Run aborted before completion.");
    },
  }) as StreamTextResult<ToolSet, never>;

  Promise.resolve(result.finishReason)
    .then(() => {
      if (capturedError === undefined) {
        resolveError(undefined);
        span.setStatus({ code: SpanStatusCode.OK });
      }
    })
    .finally(() => span.end());

  return { result, error: errorPromise, span };
}
