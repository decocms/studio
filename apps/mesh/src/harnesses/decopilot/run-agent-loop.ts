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
} from "ai";
import type { ModelsConfig } from "../../api/routes/decopilot/types";
import type { ToolApprovalLevel } from "../../api/routes/decopilot/helpers";
import type { UsageStats } from "@decocms/mesh-sdk";
import { OPENROUTER_CACHE_PROVIDER_OPTIONS } from "../../api/routes/decopilot/cache-instrumentation";
import { createLanguageModel } from "../../ai-providers/language-model";
import {
  DEFAULT_MAX_TOKENS,
  PARENT_STEP_LIMIT,
  SUBAGENT_STEP_LIMIT,
} from "../../api/routes/decopilot/constants";

export interface RunAgentLoopOptions {
  ctx: MeshContext;
  organization: OrganizationScope;
  virtualMcp: { id: string; instructions?: string };
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
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
  onUsageAggregated?: (usage: UsageStats) => void;

  // ── Stage 1 shim — deleted in Stage 2 once runAgentLoop owns
  //    tool + system assembly itself.
  __tools?: ToolSet;
  __system?: unknown;
  __prepareStep?: unknown;

  // ── Testing shim — allows injecting a fake streamText in unit tests.
  //    Stage 1 only; deleted together with the other shims in Stage 2.
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
  if (opts.kind === "subagent") {
    throw new Error(
      "runAgentLoop: kind 'subagent' not yet implemented in Stage 1",
    );
  }

  const tracer = opts.tracer ?? trace.getTracer("decopilot");
  const stepLimit =
    opts.stepLimit ??
    (opts.kind === "agent" ? PARENT_STEP_LIMIT : SUBAGENT_STEP_LIMIT);

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

  // ── streamText ────────────────────────────────────────────────────
  // Stage 1 shim: caller passes pre-assembled tools/system/prepareStep
  // via __tools/__system/__prepareStep. Stage 2 deletes the shim by
  // calling buildAgentSystemPrompt + assembleAgentTools here.
  const streamTextFn = opts.__streamText ?? streamText;
  // __streamText test shim bypasses real provider; model is only needed
  // for the real streamText path.
  const model = opts.__streamText
    ? (undefined as never)
    : createLanguageModel(opts.provider, opts.models.thinking);
  const result = streamTextFn({
    model,
    system: (opts as { __system?: unknown }).__system as never,
    messages: opts.messages,
    tools: (opts as { __tools?: ToolSet }).__tools as ToolSet,
    providerOptions: OPENROUTER_CACHE_PROVIDER_OPTIONS,
    prepareStep: (opts as { __prepareStep?: unknown }).__prepareStep as never,
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
      if (capturedError === undefined) resolveError(undefined);
      span.setStatus({ code: SpanStatusCode.OK });
    })
    .finally(() => span.end());

  return { result, error: errorPromise, span };
}
