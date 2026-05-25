/**
 * Codex harness — wraps the `codex` app-server via
 * `ai-sdk-provider-codex-cli`.
 *
 * Unlike Decopilot, this harness:
 *  - Does NOT register built-in tools (the CLI manages its own tools and
 *    reaches mesh's MCP endpoint directly).
 *  - Does NOT build a system prompt (the CLI has its own).
 *  - Does NOT support resume. Per the inline source at
 *    `apps/mesh/src/api/routes/decopilot/stream-core.ts` lines 969–971:
 *    "Codex thread resume is not supported because each request spawns a
 *    new codexAppServer process. Thread IDs are local to a process and
 *    cannot be resumed by a different one." Any `input.resumeSessionRef`
 *    is therefore intentionally ignored.
 *
 * CRITICAL: createCodexModel returns `{ model, provider }` where
 * `provider` is a spawned child process (codex app-server). It MUST be
 * `.close()`-ed on stream completion, error, OR abort — otherwise the
 * subprocess leaks. We guarantee that via a try/finally around the entire
 * streamText loop. This preserves the cleanup semantics that used to live
 * inline at stream-core.ts:540–544 (where `codexProvider?.close()` was
 * called from the `closeClients` cleanup hook).
 *
 * Behavior parity with stream-core: the inline call at lines 921–937
 * passes `mcpServers` (single `cms` entry), `toolApprovalLevel`, and
 * `isPlanMode` — all three are forwarded here. `rmcpClient`,
 * `sandboxPolicy`, and the timeout settings are baked-in defaults of
 * `createCodexModel` itself (see
 * `apps/mesh/src/ai-providers/coding-agents/codex/index.ts`) and not
 * options the call site controls.
 *
 * The harness yields raw `UIMessageChunk` — including the
 * `finish-step.providerMetadata["codex-app-server"]` block. The shared
 * stream layer (Task 12) is responsible for inspecting those chunks if
 * it needs to surface any codex-specific metadata (e.g., for analytics);
 * Codex does NOT use it for resume.
 */

import { streamText, type UIMessageChunk } from "ai";
import { createCodexModel, resolveCodexModelId } from "./model";
import { prepCliMessages } from "../cli-message-prep";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { createUsageAccumulator } from "../usage-accumulator";

export const codexHarnessFactory: HarnessFactory = {
  id: "codex",
  create(_ctx: HarnessContext): Harness {
    return {
      id: "codex",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        // 1. Resolve the composite `codex:<model>` id to the SDK model
        //    name (e.g. `gpt-5.4`). Mirrors stream-core line 922.
        const sdkModelId = resolveCodexModelId(input.models.thinking.id);

        // 2. Build the Codex language model. The MCP URL + headers are
        //    already minted by the shared layer (it owns the
        //    temp-API-key lifecycle); the harness just forwards them.
        //    Mirrors stream-core lines 921–937 — all three options
        //    (mcpServers, toolApprovalLevel, isPlanMode) are threaded
        //    through.
        //
        //    Note the transport key is `transport` (not `type`) — this
        //    matches the `createCodexModel` signature at
        //    `apps/mesh/src/ai-providers/coding-agents/codex/index.ts`
        //    line 18, where http servers are normalized to the codex
        //    SDK's `httpHeaders` shape internally.
        const { model, provider } = createCodexModel(sdkModelId, {
          mcpServers: {
            // Server name kept as `cms` for parity with the inline call
            // site (stream-core.ts:925). Changing this would alter the
            // qualified tool names the CLI emits.
            cms: {
              transport: "http",
              url: input.mcp.url,
              headers: input.mcp.headers,
            },
          },
          toolApprovalLevel: input.toolApprovalLevel,
          isPlanMode: input.mode === "plan",
        });

        try {
          // 3. Convert UIMessages to ModelMessages. The AI SDK's
          //    `streamText` validates the prompt via Zod in
          //    `standardizePrompt` and expects `ModelMessage[]`
          //    (`content: ...`), not `UIMessage[]` (`parts: [...]`).
          //    See `apps/mesh/src/harnesses/cli-message-prep.ts` for
          //    details — a previous `as never` cast hid this mismatch
          //    and would have thrown `InvalidPromptError` at runtime.
          const messages = await prepCliMessages(input.messages);

          // 4. Run streamText. Codex's CLI manages its own tools and
          //    system prompt, so we explicitly DO NOT pass `tools` or
          //    `system`. `experimental_telemetry` is also omitted to
          //    match the inline original (stream-core.ts:921–937 does
          //    not pass it for the codex branch).
          //
          //    `allowSystemInMessages: true` acknowledges that the
          //    converted ModelMessage[] may contain system-role
          //    messages inherited from prior turns of the UI history
          //    (decopilot threads occasionally carry server-built
          //    system blocks). Those are harmless here because the
          //    Codex CLI ignores them — it always uses its own system
          //    prompt — but without this flag the AI SDK 6.0.182+
          //    emits a noisy prompt-injection security warning on
          //    every turn.
          const result = streamText({
            model,
            messages,
            abortSignal: input.signal,
            allowSystemInMessages: true,
          });

          // 5. Pipe UIMessageChunk through. We surface
          //    `codingAgentSessionId` / `codingAgentProvider` at the top
          //    of the message metadata so the shared layer's stream-core
          //    persistence (`saveMessagesToThread(responseMessage)`)
          //    writes them to ThreadMessage.metadata. Codex doesn't use
          //    these for resume (per the comment at the top of this
          //    file), but the inline original at stream-core.ts:1411–
          //    1417 + 1549–1550 wrote them anyway for parity with
          //    Claude Code — so we keep the same shape.
          //
          //    We also forward cumulative `usage` (with cache token
          //    breakdown + OpenRouter cost) on both `finish-step` and
          //    `finish` chunks via the shared `usage-accumulator`. The
          //    pre-refactor stream-core (2073a39b8, lines 1411–1571)
          //    maintained the same accumulator inline; replicating it
          //    here keeps the UI's token-count tooltip working for
          //    Codex threads. Without this, the UI sees raw per-step
          //    usage and loses cache-read/write detail.
          const usageAcc = createUsageAccumulator();
          let codingAgentSessionId: string | undefined;
          const uiStream = result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              // Mirror the decopilot harness's start-chunk metadata
              // (run-stream.ts:879–906). The frontend's `onFinish`
              // reads `thread_id` from the assistant message metadata
              // to commit the locally-streamed copy to its store;
              // without it the UI logs `[chat] onFinish: no thread_id
              // in server metadata, messages not persisted` and drops
              // the message on next re-render (visible on custom-agent
              // / task-style threads that don't auto-refetch from the
              // server).
              if (part.type === "start") {
                return {
                  agent: { id: input.agent.id ?? null },
                  models: {
                    credentialId: input.models.credentialId,
                    thinking: {
                      ...input.models.thinking,
                      title:
                        input.models.thinking.title ?? input.models.thinking.id,
                      provider: input.models.thinking.provider ?? undefined,
                    },
                  },
                  created_at: new Date(),
                  thread_id: input.threadId,
                };
              }
              if (part.type === "finish-step") {
                const cx = part.providerMetadata?.["codex-app-server"] as
                  | { threadId?: string }
                  | undefined;
                if (cx?.threadId) {
                  codingAgentSessionId = cx.threadId;
                }
                usageAcc.addStep(part.usage, part.providerMetadata);
                return { usage: usageAcc.buildStepUsage() };
              }
              if (part.type === "finish") {
                const usage = usageAcc.buildFinalUsage({
                  totalUsage: part.totalUsage,
                  providerKey: input.models.thinking.provider,
                });
                return {
                  ...(usage && { usage }),
                  ...(codingAgentSessionId && {
                    codingAgentSessionId,
                    codingAgentProvider: "codex",
                  }),
                };
              }
              return undefined;
            },
          });

          try {
            for await (const chunk of uiStream) {
              yield chunk;
            }
          } finally {
            // Report cumulative usage to the surrounding scope for
            // posthog's `chat_message_completed` event. Mirrors what
            // the decopilot harness does via
            // `extras.onUsageAggregated` — without this, posthog shows
            // zeroed token counts for CLI threads. CLI harnesses may be
            // invoked without `processLocal` (e.g., from a remote
            // runner), so the call is conditional.
            const totals = usageAcc.totalTokens();
            input.processLocal?.onUsageAggregated(totals);
          }
        } finally {
          // CRITICAL: codex app-server is a per-request child process.
          // Failing to close leaks the subprocess. The try/finally
          // ensures cleanup runs on normal completion, on errors thrown
          // inside streamText, AND when the consumer abandons the
          // iterator (e.g., on abort). Preserves the cleanup that lived
          // in stream-core.ts:540–550 (the `closeClients` hook).
          await provider.close().catch(() => {});
        }
      },
    };
  },
};
