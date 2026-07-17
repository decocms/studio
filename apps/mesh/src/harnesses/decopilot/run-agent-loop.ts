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
import type { ModelsConfig } from "@decocms/harness/types";
import type { ToolApprovalLevel } from "@decocms/harness/decopilot/mcp-tools";
import type { GithubRepo, UsageStats } from "@decocms/mesh-sdk";
import { createLanguageModel } from "@decocms/harness/decopilot/mesh-provider";
import { resolveMaxOutputTokens } from "@decocms/harness/decopilot/harness-constants";
import { estimateJsonTokens } from "@decocms/harness/decopilot/built-in-tools/read-tool-output";
import {
  PARENT_STEP_LIMIT,
  SUBAGENT_STEP_LIMIT,
} from "@decocms/harness/decopilot/prompt-constants";
import { buildAgentSystemPrompt } from "./build-agent-system-prompt";
import { assembleAgentTools } from "./assemble-agent-tools";
import type { BuiltinToolParams } from "./built-in-tools";
import { buildClusterMcpToolHooks } from "@/api/routes/decopilot/cluster-mcp-tool-hooks";
import {
  advanceTaskBoardForRun,
  capturePrForRun,
  isPrCreateBashCommand,
} from "@/tools/task-board/run-reactions";
import type { SubtaskParams } from "./built-in-tools/subtask";
import type { ConnectionsBlockTool } from "@decocms/harness/decopilot/connections-block";
import {
  runNativeAgentLoopCore,
  type NativeAgentLoopCoreHandle,
} from "@decocms/harness/decopilot/native-agent-loop-core";
import type { CodingWorkspacePromptInput } from "@decocms/harness/coding-workspace-prompt";

export interface RunAgentLoopOptions {
  ctx: StudioContext;
  organization: OrganizationScope;
  virtualMcp: {
    id: string;
    instructions?: string;
    repo?: GithubRepo;
    delegationTargetIds?: string[] | null;
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
  userContext?: import("@decocms/harness/types").HarnessUserContext;
  codingWorkspace?: CodingWorkspacePromptInput;
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
  /** Full built-in params for a SUBAGENT — gives a delegated subagent the
   *  parent's heavy built-ins (vm file tools, generate_image, web_search) instead
   *  of the light core. Forwarded verbatim to `assembleAgentTools`. */
  subagentBuiltInParams?: Omit<BuiltinToolParams, "toolOutputMap">;
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
    codingWorkspace: opts.codingWorkspace,
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
  // Cluster MCP tool-call hooks: storage-ref resolution + posthog
  // analytics, built from ctx. The portable assembler forwards them as-is.
  const { resolveArgs, onToolCalled, onPrOpened } = buildClusterMcpToolHooks(
    opts.ctx,
    opts.currentThreadId,
  );
  const { tools: assembledTools } = await assembleAgentTools({
    kind: opts.kind,
    ctx: opts.ctx,
    mcpClient: opts.mcpClient,
    writer: opts.writer,
    planMode,
    toolApprovalLevel,
    subtaskParams: opts.subtaskParams,
    resolveArgs,
    onToolCalled,
    onPrOpened,
    fullBuiltInParams: opts.subagentBuiltInParams,
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

  // Watch each step's bash calls for `gh pr create` (or a REST fallback) and
  // move a linked task card to In Review. The scan itself is a cheap per-step
  // array walk, so it's unconditional — a normal run never has a `bash` call
  // matching the PR regexes, and `advanceTaskBoardForRun` hits the DB only when
  // one does: a link SELECT to resolve the target, then a write only if that
  // run is actually task-linked (a non-task match reads nothing to update).
  // (The GitHub MCP tool path is caught separately via
  // `onToolCalled`, whose raw tool name is reliable; here the model-facing tool
  // name can be mangled, so we key off the built-in `bash` tool + its command.)
  // `currentThreadId` lets the resolution fall back to the thread link when the
  // run carries no `runMetadata.taskBoardItemId` (a re-prompted task's 2nd PR).
  const onStepFinish: StreamTextOnStepFinishCallback<ToolSet> = (step) => {
    for (const call of step.toolCalls ?? []) {
      const command = (call.input as { command?: string } | undefined)?.command;
      if (
        call.toolName === "bash" &&
        command &&
        isPrCreateBashCommand(command)
      ) {
        void advanceTaskBoardForRun(
          opts.ctx,
          "in_review",
          opts.currentThreadId,
        );
        // Link the PR too — its URL is in the bash call's stdout (`gh pr create`
        // prints it; a `curl … /pulls` POST returns it in the response body).
        // Only parse the matched call's own output, never every bash stdout.
        const output = (step.toolResults ?? []).find(
          (r) => (r as { toolCallId?: string }).toolCallId === call.toolCallId,
        ) as { output?: unknown } | undefined;
        void capturePrForRun(
          opts.ctx,
          output?.output,
          null,
          opts.currentThreadId,
        );
        break;
      }
    }
    return opts.onStepFinish?.(step);
  };

  const handle = runNativeAgentLoopCore({
    model,
    systemMessages,
    messages: opts.messages,
    tools,
    prepareStep: opts.prepareStep as never,
    temperature: opts.temperature,
    maxOutputTokens: resolveMaxOutputTokens(
      opts.models.thinking.limits,
      estimateJsonTokens(systemMessages) +
        estimateJsonTokens(opts.messages) +
        estimateJsonTokens(tools),
    ),
    stopWhen: stepCountIs(stepLimit),
    abortSignal: opts.abortSignal,
    onStepFinish,
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
    .catch((err: unknown) => {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : `${err}`;
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    })
    .finally(() => span.end());

  return {
    result: handle.result,
    error: handle.error,
    span,
    assembledSystemMessages: systemMessages,
  };
}
