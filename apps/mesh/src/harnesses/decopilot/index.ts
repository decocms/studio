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
 * Owns `processConversation` itself (rather than receiving its outputs
 * through processLocal) because `convertToModelMessages` needs the real
 * tool set — three decopilot tools define `toModelOutput` handlers
 * (passthrough MCP truncation, take-screenshot formatting, subtask
 * summary extraction). Running it here, AFTER `assembleDecopilotTools`,
 * ensures prior-turn tool outputs get transformed correctly instead of
 * leaking raw JSON into every subsequent turn.
 */

import type { UIMessageChunk } from "ai";
import type { HarnessContext } from "../../core/harness-context";
import type { StudioContext } from "../../core/studio-context";
import type {
  DecopilotModelSource,
  Harness,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import type { ChatMessage } from "../../api/routes/decopilot/types";
import { processConversation } from "../../api/routes/decopilot/conversation";
import { DEFAULT_WINDOW_SIZE } from "../../api/routes/decopilot/constants";
import { assembleDecopilotTools } from "./tools";
import { assembleDecopilotPrompt } from "./prompt";
import { runDecopilotStream } from "./run-stream";
import type { PendingImage } from "./built-in-tools";
import { createHtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import { createProviderFromSecret } from "./provider-from-secret";
import type { DecopilotSecretModelSource } from "../types";
import { createSideChannelWriter } from "../side-channel-writer";

/** Narrowed view of the cluster's richer input fields, mirroring what
 *  `dispatch-run.ts` actually builds. */
interface ClusterInputView {
  messages: ChatMessage[];
}

function resolveSecretModelSource(
  input: HarnessStreamInput,
): DecopilotSecretModelSource {
  const source =
    input.modelSources?.primary ??
    (input.modelSource?.kind === "secret" ? input.modelSource : null);
  if (!source || source.kind !== "secret") {
    throw new Error(
      "Decopilot harness requires a secret modelSource. Dispatch must resolve " +
        "the selected model credential before invoking Decopilot.",
    );
  }
  return source;
}

function optionalSecretModelSource(
  source: DecopilotModelSource | undefined,
): DecopilotSecretModelSource | undefined {
  if (!source) return undefined;
  if (source.kind !== "secret") {
    throw new Error(
      "Decopilot harness requires secret modelSources for all resolved slots.",
    );
  }
  return source;
}

export const decopilotHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    // `storage` and `db` are required fields on StudioContext but absent
    // from HarnessContext. The desktop daemon runs decopilot via the
    // import-isolated `decopilotDesktopHarnessFactory`
    // (`harnesses/decopilot-desktop/`), registered directly in the daemon —
    // it never calls THIS cluster factory, so there's no desktop branch here.
    const ctx = harnessCtx as StudioContext;
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const clusterInput = input as HarnessStreamInput & ClusterInputView;
        const modelSource = resolveSecretModelSource(input);
        const provider = createProviderFromSecret(modelSource);
        const imageProvider = createProviderFromSecret(
          optionalSecretModelSource(input.modelSources?.image) ?? modelSource,
        );
        const deepResearchProvider = createProviderFromSecret(
          optionalSecretModelSource(input.modelSources?.deepResearch) ??
            modelSource,
        );
        const titleModelSource = optionalSecretModelSource(
          input.modelSources?.title,
        );
        const titleProvider = createProviderFromSecret(
          titleModelSource ?? modelSource,
        );
        const toolOutputMap = new Map<string, string>();
        const pendingImages: PendingImage[] = [];
        const sideChannel = createSideChannelWriter();
        const htmlPageBuffer = createHtmlPageBuffer(ctx, sideChannel.writer);
        let tools: Awaited<ReturnType<typeof assembleDecopilotTools>> | null =
          null;

        try {
          tools = await assembleDecopilotTools(input, ctx, {
            writer: sideChannel.writer,
            toolOutputMap,
            pendingImages,
            threadId: input.threadId,
            provider,
            imageProvider,
            deepResearchProvider,
            htmlPageBuffer,
          });

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
          } = await processConversation(clusterInput.messages, {
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
            provider,
            titleProvider,
            titleModel:
              input.models.title ?? input.models.fast ?? input.models.thinking,
            registrySignal: input.signal ?? new AbortController().signal,
            processedSystemMessages,
            processedMessages: narrowedMessages,
            originalMessages,
            threadId: input.threadId,
            currentThreadTitle: input.currentThreadTitle ?? "",
            pendingImages,
            writer: sideChannel.writer,
            sideChunks: sideChannel.stream,
            closeSideChunks: sideChannel.close,
            onStepFinish: async () => {
              await htmlPageBuffer.flush().catch((err) => {
                console.error("[decopilot] html-page flush failed", err);
              });
            },
          });
        } finally {
          sideChannel.close();
          await tools?.close().catch(() => {});
        }
      },
    };
  },
};
