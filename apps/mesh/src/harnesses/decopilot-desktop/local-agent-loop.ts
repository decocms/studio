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
  streamText,
  type SystemModelMessage,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import { createEnableToolTool } from "../decopilot/built-in-tools/enable-tool";
import { createUsageAccumulator } from "../usage-accumulator";
import { genTitle } from "../decopilot/title-generator";
import { makeTitleResultChunk } from "../title-chunk";
import { OPENROUTER_CACHE_PROVIDER_OPTIONS } from "../../api/routes/decopilot/cache-instrumentation";
import { resolveModeConfig } from "../../api/routes/decopilot/mode-config";
import {
  createLanguageModel,
  type LanguageModelProvider,
} from "./local-language-model";
import { type ConnectionsBlockTool } from "../decopilot/connections-block";
import { buildDesktopPrompt, PARENT_STEP_LIMIT } from "./local-prompt";
import type { ChatMode, ModelsConfig } from "../types";

/** Local mirror of `take-screenshot.ts:PendingImage` — defined here so we don't
 *  import that module (it pulls in `StudioContext`). Stays empty in phase 1
 *  (no desktop screenshot/VM tools), but the injection logic is kept identical
 *  for parity. */
interface PendingImage {
  url: string;
  mediaType: string;
  pageUrl?: string;
  label?: string;
}

/**
 * Reconstruct the set of enabled tools from conversation history. Scans for
 * prior `enable_tool(s)` results and re-adds their tool names. Copy of
 * `run-stream.ts:reconstructEnabledTools`.
 */
function reconstructEnabledTools(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
  availableToolNames: Set<string>,
): Set<string> {
  const enabled = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      const p = part as {
        toolName?: string;
        result?: { enabled?: string[] };
      };
      if (
        (p.toolName === "enable_tool" || p.toolName === "enable_tools") &&
        p.result
      ) {
        const result = p.result;
        if (Array.isArray(result.enabled)) {
          for (const name of result.enabled) {
            const normalized = name.replace(/[^a-zA-Z0-9_]/g, "_");
            if (availableToolNames.has(normalized)) {
              enabled.add(normalized);
            } else if (availableToolNames.has(name)) {
              enabled.add(name);
            }
          }
        }
      }
    }
  }
  return enabled;
}

export interface RunDesktopAgentLoopOptions {
  /** The provider built from `mcp.modelSecret`. */
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

  /** Aborts when the consumer disconnects or the user cancels. */
  abortSignal: AbortSignal;

  /** Current thread id (for the start-chunk metadata `thread_id`). */
  threadId: string;
  /** Current persisted thread title — title gen only runs on the default. */
  currentThreadTitle: string;
  agentIdForMetadata: string;
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

  // ── prepareStep: image injection + plan-mode filter + forced-first-step.
  //    Copied from run-stream.ts:parentPrepareStep (behaviour-identical). ─
  const pendingImages: PendingImage[] = [];
  const forcedFirstStepToolName =
    modeConfig.forcedFirstStepTool &&
    modeConfig.forcedFirstStepTool in streamTools
      ? modeConfig.forcedFirstStepTool
      : null;
  let stepIndex = 0;

  // biome-ignore lint/suspicious/noExplicitAny: complex AI SDK prepareStep generics
  const prepareStep = (stepArgs: any) => {
    const stepMessages = stepArgs.messages;
    const isFirstStep = stepIndex === 0;
    stepIndex++;

    // biome-ignore lint/suspicious/noExplicitAny: complex AI SDK message content generics
    let withImages: any = stepMessages;
    if (pendingImages.length > 0) {
      const imageParts = pendingImages.splice(0, pendingImages.length);
      const content: unknown[] = [];
      for (const img of imageParts) {
        content.push({
          type: "text",
          text:
            img.label ??
            (img.pageUrl ? `[Screenshot of ${img.pageUrl}]` : "[Image]"),
        });
        if (img.url.startsWith("data:")) {
          const match = img.url.match(/^data:([^;]+);base64,(.+)$/s);
          if (match) {
            content.push({
              type: "image",
              image: match[2],
              mimeType: match[1],
            });
          }
        } else {
          content.push({
            type: "image",
            image: new URL(img.url),
          });
        }
      }
      withImages = [...stepMessages, { role: "user", content }];
    }

    const messagesForStep = withImages;

    let activeToolNames = [
      ...builtInToolNames,
      ...(hasEnableTool ? ["enable_tool"] : []),
      ...enabledTools,
    ];

    // Plan-mode safety net: drop any non-read-only tool that got enabled.
    if (modeConfig.isPlanMode) {
      activeToolNames = activeToolNames.filter((name) => {
        if (
          builtInToolNames.includes(name) ||
          (hasEnableTool && name === "enable_tool")
        ) {
          return true;
        }
        const annotations = toolAnnotations.get(name);
        return annotations?.readOnlyHint === true;
      });
    }

    const forcedToolName =
      forcedFirstStepToolName && isFirstStep ? forcedFirstStepToolName : null;

    return {
      activeTools: activeToolNames as (keyof typeof streamTools)[],
      messages: messagesForStep,
      ...(forcedToolName && {
        toolChoice: {
          type: "tool" as const,
          toolName: forcedToolName as never,
        },
      }),
    };
  };

  // ── Auto-title with the fast model (or thinking as fallback). ─────────
  const userMessageText = JSON.stringify(processedMessages[0]?.content ?? "");
  const titleHandle = genTitle({
    abortSignal,
    model: createLanguageModel(
      provider,
      models.fast ?? models.thinking,
    ) as never,
    userMessage: userMessageText,
  });
  const titlePromise = titleHandle.promise
    .then((title) =>
      title ? (makeTitleResultChunk(title) as UIMessageChunk) : null,
    )
    .catch((err) => {
      console.warn("[decopilot-desktop:title] title generation failed", err);
      return null;
    });

  // ── streamText ────────────────────────────────────────────────────────
  const usageAcc = createUsageAccumulator();
  let reasoningStartAt: Date | null = null;

  const model = createLanguageModel(provider, models.thinking);
  const result = streamText({
    model,
    system: systemMessages,
    messages: processedMessages,
    tools: streamTools,
    providerOptions: OPENROUTER_CACHE_PROVIDER_OPTIONS,
    prepareStep: prepareStep as never,
    temperature,
    maxOutputTokens: models.thinking.limits?.maxOutputTokens ?? 32768,
    stopWhen: stepCountIs(PARENT_STEP_LIMIT),
    abortSignal,
    onError: ({ error }: { error?: unknown }) => {
      console.error("[decopilot-desktop] stream error", error);
    },
  });

  const uiMessageStream = result.toUIMessageStream({
    originalMessages: originalMessages as never,
    generateMessageId: undefined,
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return {
          agent: { id: opts.agentIdForMetadata ?? null },
          models: {
            credentialId: models.credentialId,
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
    | { kind: "title"; value: UIMessageChunk | null };

  const iter = uiMessageStream[Symbol.asyncIterator]();
  let mainDone = false;
  let titleDone = false;
  let mainPromise: Promise<Settled> = iter
    .next()
    .then((value) => ({ kind: "main" as const, value }));
  const titleResultPromise: Promise<Settled> = titlePromise.then((value) => ({
    kind: "title" as const,
    value,
  }));

  try {
    while (!mainDone || !titleDone) {
      const pending: Promise<Settled>[] = [];
      if (!mainDone) pending.push(mainPromise);
      if (!titleDone) pending.push(titleResultPromise);

      const settled = await Promise.race(pending);
      if (settled.kind === "main") {
        if (settled.value.done) {
          mainDone = true;
          if (!titleDone) titleHandle.finish();
          continue;
        }
        yield settled.value.value;
        mainPromise = iter
          .next()
          .then((value) => ({ kind: "main" as const, value }));
        continue;
      }
      titleDone = true;
      if (settled.value) yield settled.value;
    }
  } finally {
    if (!titleDone) titleHandle.finish();
  }
}
