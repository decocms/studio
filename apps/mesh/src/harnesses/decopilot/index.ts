/**
 * Decopilot harness — the in-tree native runtime.
 *
 * Wraps the existing `streamText` loop with the platform's built-in
 * tools and full system-prompt assembly. Composed from three pieces
 * extracted from `stream-core.ts`:
 *  - `assembleDecopilotTools` (./tools.ts)
 *  - `assembleDecopilotPrompt` (./prompt.ts)
 *  - `runDecopilotStream` (./run-stream.ts)
 *
 * Created per-call (one `Harness` instance per stream) because the
 * underlying `streamText` loop is stateful (tool registration, MCP
 * passthrough client lifetime, per-thread state). The factory captures
 * `ctx` so the `HarnessStreamInput` shape stays serializable for a
 * future remote transport.
 *
 * REQUIRES `input.processLocal` — decopilot reads the writer, runRegistry,
 * processedMessages, mutable-state bridges, and other in-process extras
 * out of that field. Remote dispatch will need a different bridge; today
 * the harness throws if processLocal is missing.
 *
 * Owns `processConversation` itself (rather than receiving its outputs
 * through processLocal) because `convertToModelMessages` needs the real
 * tool set — three decopilot tools define `toModelOutput` handlers
 * (passthrough MCP truncation, take-screenshot formatting, subtask
 * summary extraction). Running it here, AFTER `assembleDecopilotTools`,
 * ensures prior-turn tool outputs get transformed correctly instead of
 * leaking raw JSON into every subsequent turn.
 */

import type { UIMessageChunk } from "ai";
import type { MeshContext } from "../../core/mesh-context";
import type { Harness, HarnessFactory, HarnessStreamInput } from "../types";
import { processConversation } from "../../api/routes/decopilot/conversation";
import { DEFAULT_WINDOW_SIZE } from "../../api/routes/decopilot/constants";
import { assembleDecopilotTools } from "./tools";
import { assembleDecopilotPrompt } from "./prompt";
import { runDecopilotStream } from "./run-stream";

export const decopilotHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(ctx: MeshContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const pl = input.processLocal;
        if (!pl) {
          throw new Error(
            "Decopilot harness requires HarnessStreamInput.processLocal in this build. " +
              "Remote dispatch is not yet supported.",
          );
        }
        if (!pl.provider) {
          throw new Error(
            "Decopilot harness requires processLocal.provider to be activated.",
          );
        }

        const tools = await assembleDecopilotTools(input, ctx, {
          writer: pl.writer,
          toolOutputMap: pl.toolOutputMap,
          pendingImages: pl.pendingImages,
          threadId: pl.threadId,
          provider: pl.provider,
        });

        try {
          // Run `processConversation` with the REAL tool set — the AI SDK's
          // `convertToModelMessages` calls `tools[name].toModelOutput()` to
          // transform prior-turn tool results. Three decopilot tools
          // implement this:
          //  - Passthrough MCP tools (truncate oversized outputs with a
          //    "too long, preview:..." text)
          //  - `take-screenshot` (formats as "Screenshot of {url} captured")
          //  - `subtask` (extracts the last text part as a summary)
          // Without the real tool set, prior turns' raw JSON would leak
          // through every turn → context bloat → eventual context overflow
          // on long threads.
          const {
            systemMessages: processedSystemMessages,
            messages: processedMessages,
            originalMessages,
          } = await processConversation(input.messages, {
            windowSize: DEFAULT_WINDOW_SIZE,
            models: input.models,
            tools: tools.tools,
          });

          // `processConversation` splits out system messages internally,
          // so the returned `messages` array only ever contains
          // user/assistant/tool. Narrow at the boundary.
          const narrowedMessages = processedMessages as Parameters<
            typeof runDecopilotStream
          >[4]["processedMessages"];

          const prompt = await assembleDecopilotPrompt(input, ctx, tools);

          yield* runDecopilotStream(input, ctx, tools, prompt, {
            provider: pl.provider,
            registrySignal: pl.registrySignal,
            runRegistry: pl.runRegistry,
            processedSystemMessages,
            processedMessages: narrowedMessages,
            originalMessages,
            threadId: pl.threadId,
            currentThreadTitle: pl.currentThreadTitle,
            registerPendingOp: pl.registerPendingOp,
            isStreamFinished: pl.isStreamFinished,
            onUsageAggregated: pl.onUsageAggregated,
            pendingImages: pl.pendingImages,
          });
        } finally {
          await tools.close().catch(() => {});
        }
      },
    };
  },
};
