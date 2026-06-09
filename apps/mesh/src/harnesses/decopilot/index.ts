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
 * REQUIRES `input.decopilotRuntime` — decopilot reads the writer, runRegistry,
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
import type { HarnessContext } from "../../core/harness-context";
import type { StudioContext } from "../../core/studio-context";
import type {
  DecopilotModelSource,
  DecopilotRuntime,
  Harness,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import type { RunRegistry } from "../../api/routes/decopilot/run-registry";
import type { ChatMessage, ModelInfo } from "../../api/routes/decopilot/types";
import type { ChatMode } from "../../api/routes/decopilot/mode-config";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import { processConversation } from "../../api/routes/decopilot/conversation";
import { DEFAULT_WINDOW_SIZE } from "../../api/routes/decopilot/constants";
import { assembleDecopilotTools } from "./tools";
import { assembleDecopilotPrompt } from "./prompt";
import { runDecopilotStream } from "./run-stream";
import type { PendingImage } from "./built-in-tools";
import type { HtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import {
  findStudioPackAgentByMcpId,
  resolveStudioPackRuntime,
} from "../../tools/virtual/studio-pack";
import { createProviderFromSecret } from "./provider-from-secret";
import type { DecopilotSecretModelSource } from "../types";

type ClusterDecopilotRuntime = DecopilotRuntime & {
  pendingImages: PendingImage[];
  runRegistry: RunRegistry;
  titleModel?: ModelInfo | null;
  htmlPageBuffer: HtmlPageBuffer;
};

/** Narrowed view of the cluster's richer input fields, mirroring what
 *  `dispatch-run.ts` actually builds. */
interface ClusterInputView {
  messages: ChatMessage[];
  mode: ChatMode;
  virtualMcp: VirtualMCPEntity;
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
    // `stream()` refuses to run without decopilotRuntime, so any cluster-only
    // ctx field reads only happen on a real StudioContext value. The widening
    // cast here is a TS-level erasure; the defensive check below catches a
    // narrow HarnessContext smuggled in via misuse (e.g. a non-decopilot
    // caller mistakenly invoking this factory on the desktop).
    //
    // `storage` and `db` are required fields on StudioContext but absent
    // from HarnessContext. The desktop daemon runs decopilot via the
    // import-isolated `decopilotDesktopHarnessFactory`
    // (`harnesses/decopilot-desktop/`), registered directly in the daemon —
    // it never calls THIS cluster factory, so there's no desktop branch here.
    const ctx = harnessCtx as StudioContext;
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        // Package types are intentionally loose so the harness package
        // is daemon-portable; narrow back to cluster-rich types here.
        const runtime = input.decopilotRuntime as
          | ClusterDecopilotRuntime
          | undefined;
        const clusterInput = input as HarnessStreamInput & ClusterInputView;
        if (!runtime) {
          throw new Error(
            "Decopilot harness requires HarnessStreamInput.decopilotRuntime in this build. " +
              "Remote dispatch is not yet supported.",
          );
        }
        const modelSource = resolveSecretModelSource(input);
        const provider = createProviderFromSecret(modelSource);
        const imageProvider = createProviderFromSecret(
          optionalSecretModelSource(input.modelSources?.image) ?? modelSource,
        );
        const deepResearchProvider = createProviderFromSecret(
          optionalSecretModelSource(input.modelSources?.deepResearch) ??
            modelSource,
        );
        const titleProvider = createProviderFromSecret(
          optionalSecretModelSource(input.modelSources?.title) ?? modelSource,
        );

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

        const tools = await assembleDecopilotTools(effectiveInput, ctx, {
          writer: runtime.writer,
          toolOutputMap: runtime.toolOutputMap,
          pendingImages: runtime.pendingImages,
          threadId: runtime.threadId,
          provider,
          imageProvider,
          deepResearchProvider,
          htmlPageBuffer: runtime.htmlPageBuffer,
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
            provider,
            titleProvider,
            titleModel:
              runtime.titleModel ?? input.models.fast ?? input.models.thinking,
            registrySignal: runtime.registrySignal,
            runRegistry: runtime.runRegistry,
            processedSystemMessages,
            processedMessages: narrowedMessages,
            originalMessages,
            threadId: runtime.threadId,
            currentThreadTitle: runtime.currentThreadTitle,
            registerPendingOp: runtime.registerPendingOp,
            isStreamFinished: runtime.isStreamFinished,
            onUsageAggregated: runtime.onUsageAggregated,
            pendingImages: runtime.pendingImages,
            onTitleUpdated: runtime.onTitleUpdated,
            writer: runtime.writer,
          });
        } finally {
          await tools.close().catch(() => {});
        }
      },
    };
  },
};
