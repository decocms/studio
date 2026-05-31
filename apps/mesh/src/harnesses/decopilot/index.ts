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

import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import type { HarnessContext } from "../../core/harness-context";
import type { MeshContext } from "../../core/mesh-context";
import type { Harness, HarnessFactory, HarnessStreamInput } from "../types";
import type { MeshProvider } from "../../ai-providers/types";
import type { RunRegistry } from "../../api/routes/decopilot/run-registry";
import type { ChatMessage } from "../../api/routes/decopilot/types";
import type { ChatMode } from "../../api/routes/decopilot/mode-config";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import { processConversation } from "../../api/routes/decopilot/conversation";
import { DEFAULT_WINDOW_SIZE } from "../../api/routes/decopilot/constants";
import { assembleDecopilotTools } from "./tools";
import { assembleDecopilotPrompt } from "./prompt";
import { runDecopilotStream } from "./run-stream";
import { SlotUnresolvedError } from "@/core/slot-resolver";
import type { PendingImage } from "./built-in-tools";
import type { HtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import {
  findStudioPackAgentByMcpId,
  resolveStudioPackRuntime,
} from "../../tools/virtual/studio-pack";

/** Narrowed view of `HarnessStreamInput.processLocal` for the cluster
 *  decopilot harness. The package types those structurally-deep fields
 *  as `unknown` so the package stays portable to the desktop daemon; the
 *  cluster knows it builds richer values and narrows here at the
 *  harness boundary. */
interface ClusterProcessLocal {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  pendingImages: PendingImage[];
  threadId: string;
  currentThreadTitle: string;
  registrySignal: AbortSignal;
  runRegistry: RunRegistry;
  provider: MeshProvider | null;
  /** Provider used for `generate_image`. Aliases `provider` when the org
   *  `image` tier shares the chat credential (or no tier is configured). */
  imageProvider: MeshProvider | null;
  /** Provider used for `web_search`'s deep research path. Aliases
   *  `provider` when the org `web_research` tier shares the chat
   *  credential (or no tier is configured). Decoupling lets web_search
   *  keep working when the chat model is routed via LiteLLM/OpenRouter
   *  but the deep research tier is still Gemini. */
  deepResearchProvider: MeshProvider | null;
  registerPendingOp: (op: Promise<void>) => void;
  isStreamFinished: () => boolean;
  onUsageAggregated: (totalUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;
  onTitleUpdated?: (title: string) => void | Promise<void>;
  /** Per-turn HTML-page coalescing buffer. Built in dispatch-run.ts so the
   *  flush hook can be scheduled alongside the other `pendingOps`. */
  htmlPageBuffer: HtmlPageBuffer;
}

/** Narrowed view of the cluster's richer input fields, mirroring what
 *  `dispatch-run.ts` actually builds. */
interface ClusterInputView {
  messages: ChatMessage[];
  mode: ChatMode;
  virtualMcp: VirtualMCPEntity;
}

export const decopilotHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    // `stream()` refuses to run without processLocal, so any cluster-only
    // ctx field reads only happen on a real MeshContext value. The widening
    // cast here is a TS-level erasure; the defensive check below catches a
    // narrow HarnessContext smuggled in via misuse (e.g. a non-decopilot
    // caller mistakenly invoking this factory on the desktop).
    //
    // `storage` and `db` are required fields on MeshContext but absent
    // from HarnessContext, so their presence reliably distinguishes the
    // two at runtime.
    if (!("storage" in harnessCtx) || !("db" in harnessCtx)) {
      throw new Error(
        "decopilot harness requires MeshContext (cluster-side only); " +
          "got narrow HarnessContext",
      );
    }
    const ctx = harnessCtx as MeshContext;
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        // Package types are intentionally loose so the harness package
        // is daemon-portable; narrow back to cluster-rich types here.
        const pl = input.processLocal as ClusterProcessLocal | undefined;
        const clusterInput = input as HarnessStreamInput & ClusterInputView;
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

        // Studio pack agents (Brand Manager, etc.) resolve their prompt
        // and tool allowlist at request time based on org state — e.g. Brand
        // Manager exposes a bootstrap toolset before any brand context
        // exists and a manage toolset after. The resolver overrides
        // `metadata.instructions` and `connections[].selected_tools`, which
        // the passthrough client honors transparently.
        const studioPackAgent = findStudioPackAgentByMcpId(input.agent.id);
        let effectiveInput: HarnessStreamInput = input;
        if (studioPackAgent) {
          const resolved = await resolveStudioPackRuntime(studioPackAgent, {
            orgId: ctx.organization!.id,
            ctx,
          });
          const baseVm = clusterInput.virtualMcp;
          const selectedTools = resolved.selectedTools
            ? [...resolved.selectedTools]
            : null;
          effectiveInput = {
            ...input,
            virtualMcp: {
              ...baseVm,
              metadata: {
                ...((baseVm.metadata as Record<string, unknown>) ?? {}),
                instructions: resolved.instructions,
              },
              connections: baseVm.connections.map((c) => ({
                ...c,
                selected_tools: selectedTools,
              })),
            },
          };
        }

        let tools: Awaited<ReturnType<typeof assembleDecopilotTools>>;
        try {
          tools = await assembleDecopilotTools(effectiveInput, ctx, {
            writer: pl.writer,
            toolOutputMap: pl.toolOutputMap,
            pendingImages: pl.pendingImages,
            threadId: pl.threadId,
            provider: pl.provider,
            imageProvider: pl.imageProvider ?? pl.provider,
            deepResearchProvider: pl.deepResearchProvider ?? pl.provider,
            htmlPageBuffer: pl.htmlPageBuffer,
          });
        } catch (err) {
          if (err instanceof SlotUnresolvedError) {
            // The parent agent's own slots are unresolved for this user.
            // Surface the connect card and end the run cleanly (no model
            // call happens) instead of a generic stream error.
            pl.writer.write({
              type: "data-connect-required",
              data: {
                agentId: err.agentId,
                agentTitle: err.agentTitle,
                appIds: err.appIds,
              },
            });
            return;
          }
          throw err;
        }

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

          const prompt = await assembleDecopilotPrompt(
            effectiveInput,
            ctx,
            tools,
          );

          yield* runDecopilotStream(effectiveInput, ctx, tools, prompt, {
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
            onTitleUpdated: pl.onTitleUpdated,
            writer: pl.writer,
          });
        } finally {
          await tools.close().catch(() => {});
        }
      },
    };
  },
};
