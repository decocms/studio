/**
 * local-agent-loop — the lean streamText loop for the desktop harness.
 *
 * Modeled on the CLI harnesses (claude-code/codex) and on the cluster's
 * `runDecopilotStream` / `runAgentLoop`, but self-contained and cluster-free:
 *   - model            ← `provider-from-secret` (via `createLanguageModel`)
 *   - tools            ← local built-ins + passthrough MCP tools + enable_tool
 *   - system           ← `buildDesktopPrompt`
 *   - prepareStep      ← image injection + plan-mode tool gating +
 *                        forced-first-step toolChoice + enabled-tool gating
 *                        (copied from `run-stream.ts`, behaviour-identical)
 *   - stopWhen         ← stepCountIs(PARENT_STEP_LIMIT)
 *   - usage            ← shared `usage-accumulator`
 *   - auto-title       ← shared `genTitle` + `makeTitleResultChunk`
 *
 * DROPPED vs the cluster loop: `monitorLlmCall` / `recordLlmCallMetrics`
 * (`@/monitoring`), the run-registry deferred-FINISH path, and the abort-time
 * metrics re-emission (no monitoring sink on the desktop). The abort-time
 * usage re-emit IS kept (the UI still needs accumulated tokens on cancel).
 *
 * Yields raw `UIMessageChunk`. The desktop dispatch layer streams these back to
 * the cluster, which persists/interprets them exactly as for the CLI harnesses.
 */

import {
  type ModelMessage,
  stepCountIs,
  type StreamTextOnStepFinishCallback,
  type SystemModelMessage,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import { createEnableToolTool } from "../decopilot/built-in-tools/enable-tool";
import { createUsageAccumulator } from "../usage-accumulator";
import { genTitle } from "../decopilot/title-generator";
import { stringifyError } from "../decopilot/stream-error";
import { makeTitleResultChunk } from "../title-chunk";
import { resolveModeConfig } from "../../api/routes/decopilot/mode-config";
import {
  createLanguageModel,
  type LanguageModelProvider,
} from "./local-language-model";
import { type ConnectionsBlockTool } from "../decopilot/connections-block";
import { buildDesktopPrompt, PARENT_STEP_LIMIT } from "./local-prompt";
import type { ChatMode, ModelsConfig } from "../types";
import {
  createAgentPrepareStep,
  reconstructEnabledTools,
} from "../decopilot/agent-loop-state";
import { runNativeAgentLoopCore } from "../decopilot/native-agent-loop-core";
import type { PendingImage } from "../decopilot/built-in-tools/vm-tools/types";

export interface RunDesktopAgentLoopOptions {
  /** The provider built from `modelSource(kind="secret")`. */
  provider: LanguageModelProvider;
  models: ModelsConfig;
  mode: ChatMode;
  temperature: number;

  /** Whether the active agent is the well-known decopilot agent. */
  isDecopilotAgent: boolean;
  agentId: string;
  /** Agent's own instructions when not decopilot. */
  agentInstructions?: string;

  /** Pruned conversation (system stripped out) from `processConversation`. */
  processedMessages: Extract<
    ModelMessage,
    { role: "user" | "assistant" | "tool" }
  >[];
  /** Per-request inline <system> blocks extracted by `processConversation`. */
  processedSystemMessages: SystemModelMessage[];
  /** The validated UIMessage[] (for title text + enabled-tool reconstruction). */
  originalMessages: Array<{ role: string; parts: ReadonlyArray<unknown> }>;

  /** Passthrough MCP tools (from `toolsFromMCP`). */
  passthroughTools: ToolSet;
  /** Local built-in tools (from `buildLocalTools`). */
  localTools: ToolSet;
  /** Connections-block tool list (drives enable_tool registration + gating). */
  connectionsBlockTools: ConnectionsBlockTool[];
  connectionTitleMap: Map<string, string>;
  /** Read-only hints per safe tool name, for plan-mode gating. */
  toolAnnotations: Map<string, { readOnlyHint?: boolean }>;
  pendingImages: PendingImage[];

  /** Aborts when the consumer disconnects or the user cancels. */
  abortSignal: AbortSignal;

  /** Current thread id (for the start-chunk metadata `thread_id`). */
  threadId: string;
  /** Current persisted thread title — title gen only runs on the default. */
  currentThreadTitle: string;
  agentIdForMetadata: string;
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
  sideChunks?: AsyncIterable<UIMessageChunk>;
}

/**
 * Run the desktop decopilot loop and yield its UIMessageChunk stream, merging a
 * background auto-title result chunk into the same iterator.
 */
export async function* runDesktopAgentLoop(
  opts: RunDesktopAgentLoopOptions,
): AsyncGenerator<UIMessageChunk> {
  const {
    provider,
    models,
    mode,
    temperature,
    processedMessages,
    processedSystemMessages,
    originalMessages,
    passthroughTools,
    localTools,
    connectionsBlockTools,
    connectionTitleMap,
    toolAnnotations,
    abortSignal,
    threadId,
  } = opts;

  const modeConfig = resolveModeConfig(mode, { isCliAgent: false });

  // ── Enabled-tool state reconstructed from history ────────────────────
  const passthroughToolNames = new Set(Object.keys(passthroughTools));
  const builtInToolNames = Object.keys(localTools);
  const enabledTools = reconstructEnabledTools(
    originalMessages,
    passthroughToolNames,
  );

  // ── Tool set: local + passthrough (+ enable_tool when there are
  //    connections to enable). Mirrors run-stream.ts streamTools. ───────
  const hasEnableTool = connectionsBlockTools.length > 0;
  const enableToolTool = hasEnableTool
    ? createEnableToolTool(enabledTools, passthroughToolNames, {
        isPlanMode: modeConfig.isPlanMode,
        toolAnnotations,
      })
    : null;
  const streamTools: ToolSet = {
    ...passthroughTools,
    ...localTools,
    ...(enableToolTool ? { enable_tool: enableToolTool } : {}),
  };

  // ── System prompt ────────────────────────────────────────────────────
  const prompt = buildDesktopPrompt({
    agentId: opts.agentId,
    isDecopilotAgent: opts.isDecopilotAgent,
    connectionsBlockTools,
    connectionTitleMap,
    agentInstructions: opts.agentInstructions,
    planPrompt: modeConfig.planPrompt,
    webSearchPrompt: modeConfig.webSearchInstructionPrompt,
  });

  // Non-cached system tail telling the model which tools it already enabled.
  const enabledToolsSystemMessage =
    enabledTools.size > 0
      ? {
          role: "system" as const,
          content: `<currently-enabled-tools>\n${[...enabledTools]
            .sort()
            .join("\n")}\n</currently-enabled-tools>`,
        }
      : null;

  const systemMessages = [
    ...prompt.systemMessages,
    ...processedSystemMessages,
    ...(enabledToolsSystemMessage ? [enabledToolsSystemMessage] : []),
  ];

  const prepareStep = createAgentPrepareStep({
    modeConfig,
    streamTools,
    builtInToolNames,
    enabledTools,
    toolAnnotations,
    pendingImages: opts.pendingImages,
    hasEnableTool,
  });

  // ── Auto-title with the fast model (or thinking as fallback). ─────────
  const userMessageText = JSON.stringify(processedMessages[0]?.content ?? "");
  const titleHandle = genTitle({
    abortSignal,
    model: createLanguageModel(
      provider,
      models.fast ?? models.smart ?? models.thinking,
    ) as never,
    userMessage: userMessageText,
  });
  const titlePromise = titleHandle.promise
    .then((title) =>
      title ? (makeTitleResultChunk(title) as UIMessageChunk) : null,
    )
    .catch((err) => {
      console.warn(
        "[decopilot-desktop:title] title generation failed",
        stringifyError(err),
      );
      return null;
    });

  // ── streamText ────────────────────────────────────────────────────────
  const usageAcc = createUsageAccumulator();
  let reasoningStartAt: Date | null = null;

  const model = createLanguageModel(provider, models.thinking);
  const handle = runNativeAgentLoopCore({
    model,
    systemMessages,
    messages: processedMessages,
    tools: streamTools,
    prepareStep,
    temperature,
    maxOutputTokens: models.thinking.limits?.maxOutputTokens ?? 32768,
    stopWhen: stepCountIs(PARENT_STEP_LIMIT),
    abortSignal,
    onStepFinish: opts.onStepFinish,
    onError: (_message, error) => {
      console.error("[decopilot-desktop] stream error", stringifyError(error));
    },
  });
  const result = handle.result;

  const uiMessageStream = result.toUIMessageStream({
    originalMessages: originalMessages as never,
    generateMessageId: undefined,
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return {
          agent: { id: opts.agentIdForMetadata ?? null },
          models: {
            credentialId: models.thinking.credentialId,
            thinking: {
              ...models.thinking,
              title: models.thinking.title ?? models.thinking.id,
              provider: models.thinking.provider ?? undefined,
            },
          },
          created_at: new Date(),
          thread_id: threadId,
        };
      }
      if (part.type === "reasoning-start") {
        if (reasoningStartAt === null) reasoningStartAt = new Date();
        return { reasoning_start_at: reasoningStartAt };
      }
      if (part.type === "reasoning-end") {
        return { reasoning_end_at: new Date() };
      }
      if (part.type === "finish-step") {
        usageAcc.addStep(part.usage, part.providerMetadata);
        return { usage: usageAcc.buildStepUsage() };
      }
      if (part.type === "finish") {
        const usage = usageAcc.buildFinalUsage({
          totalUsage: part.totalUsage,
          providerKey: models.thinking.provider,
          fallbackProviderMetadata: (
            part as { providerMetadata?: Record<string, unknown> }
          ).providerMetadata,
        });
        return usage ? { usage } : {};
      }
      return undefined;
    },
  });

  // ── Merge the main UI stream with the background title result. ────────
  type Settled =
    | { kind: "main"; value: IteratorResult<UIMessageChunk> }
    | { kind: "title"; value: UIMessageChunk | null }
    | { kind: "side"; value: IteratorResult<UIMessageChunk> };

  const iter = uiMessageStream[Symbol.asyncIterator]();
  const sideIter = opts.sideChunks?.[Symbol.asyncIterator]();
  let mainDone = false;
  let titleDone = false;
  let sideDone = sideIter === undefined;
  let mainPromise: Promise<Settled> = iter
    .next()
    .then((value) => ({ kind: "main" as const, value }));
  let sidePromise: Promise<Settled> | null = sideIter
    ? sideIter.next().then((value) => ({ kind: "side" as const, value }))
    : null;
  const titleResultPromise: Promise<Settled> = titlePromise.then((value) => ({
    kind: "title" as const,
    value,
  }));

  try {
    while (!mainDone || !titleDone || !sideDone) {
      const pending: Promise<Settled>[] = [];
      if (!mainDone) pending.push(mainPromise);
      if (!titleDone) pending.push(titleResultPromise);
      if (!sideDone && sidePromise) pending.push(sidePromise);

      const settled = await Promise.race(pending);
      if (settled.kind === "main") {
        if (settled.value.done) {
          mainDone = true;
          if (!titleDone) titleHandle.finish();
          if (!sideDone) {
            void sideIter?.return?.();
            sideDone = true;
          }
          continue;
        }
        yield settled.value.value;
        mainPromise = iter
          .next()
          .then((value) => ({ kind: "main" as const, value }));
        continue;
      }
      if (settled.kind === "side") {
        if (settled.value.done) {
          sideDone = true;
          continue;
        }
        yield settled.value.value;
        sidePromise =
          sideIter
            ?.next()
            .then((value) => ({ kind: "side" as const, value })) ?? null;
        continue;
      }
      titleDone = true;
      if (settled.value) yield settled.value;
    }
  } finally {
    if (!titleDone) titleHandle.finish();
    void sideIter?.return?.();
  }
}
