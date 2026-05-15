/**
 * Claude Code harness — wraps the `claude` CLI via
 * `ai-sdk-provider-claude-code`.
 *
 * Unlike Decopilot, this harness:
 *  - Does NOT register built-in tools (the CLI manages its own tools and
 *    reaches mesh's MCP endpoint directly).
 *  - Does NOT build a system prompt (the CLI has its own).
 *  - Supports resume via `input.resumeSessionRef`, derived by the shared
 *    layer (Task 12) from prior
 *    `finish-step.providerMetadata["claude-code"].sessionId`. The harness
 *    just forwards that opaque token to the SDK's `resume` setting.
 *
 * Working-directory resolution mirrors the inline original at
 * `apps/mesh/src/api/routes/decopilot/stream-core.ts` lines ~864–886:
 * github-linked virtual MCPs get a per-branch sandbox handle; the
 * underlying `host` runner exposes `localWorkdir(handle)` to map that
 * handle to a real filesystem path. Ephemeral agents (no `githubRepo`)
 * fall through to `undefined`, which means the SDK defaults to
 * `process.cwd()` — same as the inline original.
 *
 * Behavior parity with stream-core: the inline call at lines 888–906
 * passes `mcpServers` (single `cms` entry), `toolApprovalLevel`,
 * `isPlanMode`, `resume`, and `cwd` — all five are forwarded here.
 *
 * The harness yields raw `UIMessageChunk` — including the
 * `finish-step.providerMetadata["claude-code"]` block. The shared stream
 * layer (Task 12) is responsible for extracting the `sessionId` from
 * those chunks and persisting it to message metadata so the next turn
 * can resume.
 */

import { streamText, type UIMessageChunk } from "ai";
import {
  createClaudeCodeModel,
  resolveClaudeCodeModelId,
} from "../../ai-providers/adapters/claude-code";
import type { MeshContext } from "../../core/mesh-context";
import { getSharedRunner } from "../../sandbox/lifecycle";
import { prepCliMessages } from "../cli-message-prep";
import type { Harness, HarnessFactory, HarnessStreamInput } from "../types";
import { createUsageAccumulator } from "../usage-accumulator";

/**
 * Compute the Claude Code working directory.
 *
 * Mirrors stream-core.ts lines ~864–886. Returns `undefined` when:
 *  - The agent has no githubRepo (ephemeral agent → use SDK default cwd).
 *  - No userId is available (defensive — branch resolution needs it).
 *  - The shared runner is not the local `host` kind (Docker / remote
 *    runners don't expose a local filesystem path).
 *  - `localWorkdir(handle)` returns null (the handle isn't materialized
 *    on this pod yet).
 */
async function resolveClaudeCodeCwd(
  input: HarnessStreamInput,
  ctx: MeshContext,
): Promise<string | undefined> {
  const vmMetadata = input.virtualMcp.metadata as {
    githubRepo?: unknown;
  } | null;
  if (!vmMetadata?.githubRepo) return undefined;
  if (!input.user?.id) return undefined;

  const isEphemeralAgent = !vmMetadata.githubRepo;
  const branch = isEphemeralAgent
    ? "ephemeral"
    : (input.branch ?? `thread:${input.threadId}`);

  const runner = await getSharedRunner(ctx);
  if (runner.kind !== "host") return undefined;

  const { computeHandle, composeSandboxRef } = await import(
    "@decocms/sandbox/runner"
  );
  const projectRef = composeSandboxRef({
    orgId: input.organizationId,
    virtualMcpId: input.agent.id,
    branch,
  });
  const handle = computeHandle({ userId: input.user.id, projectRef }, branch);
  const hostRunner = runner as unknown as {
    localWorkdir(h: string): Promise<string | null>;
  };
  return (await hostRunner.localWorkdir(handle)) ?? undefined;
}

export const claudeCodeHarnessFactory: HarnessFactory = {
  id: "claude-code",
  create(ctx: MeshContext): Harness {
    return {
      id: "claude-code",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        // 1. Resolve the composite `claude-code:<size>` to the SDK model
        //    name (`opus` / `sonnet` / `haiku`). Mirrors stream-core
        //    line 889.
        const sdkModelId = resolveClaudeCodeModelId(input.models.thinking.id);

        // 2. Compute the working directory for the CLI subprocess —
        //    github-linked agents get a per-branch sandbox path, ephemeral
        //    agents fall through to undefined (SDK default).
        const cwd = await resolveClaudeCodeCwd(input, ctx);

        // 3. Build the Claude Code language model. The MCP URL + headers
        //    are already minted by the shared layer (it owns the
        //    temp-API-key lifecycle); the harness just forwards them.
        //    Mirrors stream-core lines 888–906 — all five options are
        //    threaded through.
        const languageModel = createClaudeCodeModel(sdkModelId, {
          mcpServers: {
            // Server name kept as `cms` for parity with the inline call
            // site (stream-core.ts:892). Changing this would alter the
            // qualified tool names the CLI emits.
            cms: {
              type: "http",
              url: input.mcp.url,
              headers: input.mcp.headers,
            },
          },
          toolApprovalLevel: input.toolApprovalLevel,
          isPlanMode: input.mode === "plan",
          resume: input.resumeSessionRef,
          cwd,
        });

        // 4. Convert UIMessages to ModelMessages. The AI SDK's
        //    `streamText` validates the prompt via Zod in
        //    `standardizePrompt` and expects `ModelMessage[]`
        //    (`content: ...`), not `UIMessage[]` (`parts: [...]`). See
        //    `apps/mesh/src/harnesses/cli-message-prep.ts` for details —
        //    a previous `as never` cast hid this mismatch and would have
        //    thrown `InvalidPromptError` at runtime.
        const messages = await prepCliMessages(input.messages);

        // 5. Run streamText. Claude Code's CLI manages its own tools
        //    and system prompt, so we explicitly DO NOT pass `tools` or
        //    `system`. The CLI handles `experimental_repairToolCall`
        //    internally too.
        //
        //    `allowSystemInMessages: true` acknowledges that the
        //    converted ModelMessage[] may contain system-role messages
        //    inherited from prior turns of the UI history (decopilot
        //    threads occasionally carry server-built system blocks).
        //    Those are harmless here because the Claude Code CLI
        //    ignores them — it always uses its own system prompt — but
        //    without this flag the AI SDK 6.0.182+ emits a noisy
        //    prompt-injection security warning on every turn.
        const result = streamText({
          model: languageModel,
          messages,
          abortSignal: input.signal,
          allowSystemInMessages: true,
        });

        // 6. Pipe UIMessageChunk through. We surface
        //    `codingAgentSessionId` / `codingAgentProvider` at the top of
        //    the message metadata so the shared layer's stream-core
        //    persistence (`saveMessagesToThread(responseMessage)`) writes
        //    them to ThreadMessage.metadata. Subsequent turns read those
        //    fields back to recover `input.resumeSessionRef`. Matches the
        //    inline original (stream-core.ts:1404–1417 + 1549–1550)
        //    byte-for-byte.
        //
        //    We also forward cumulative `usage` (with cache token
        //    breakdown + OpenRouter cost) on both `finish-step` and
        //    `finish` chunks via the shared `usage-accumulator`. The
        //    pre-refactor stream-core (2073a39b8, lines 1411–1571)
        //    maintained the same accumulator inline; replicating it
        //    here keeps the UI's token-count tooltip working for Claude
        //    Code threads. Without this, the UI sees raw per-step usage
        //    and loses cache-read/write detail.
        const usageAcc = createUsageAccumulator();
        let codingAgentSessionId: string | undefined;
        const uiStream = result.toUIMessageStream({
          messageMetadata: ({ part }) => {
            // Mirror the decopilot harness's start-chunk metadata
            // (run-stream.ts:879–906). The frontend's `onFinish` reads
            // `thread_id` from the assistant message metadata to commit
            // the locally-streamed copy to its store; without it the UI
            // logs `[chat] onFinish: no thread_id in server metadata,
            // messages not persisted` and drops the message on next
            // re-render (visible on custom-agent / task-style threads
            // that don't auto-refetch from the server).
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
              const cc = part.providerMetadata?.["claude-code"] as
                | { sessionId?: string }
                | undefined;
              if (cc?.sessionId) {
                codingAgentSessionId = cc.sessionId;
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
                  codingAgentProvider: "claude-code",
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
          // posthog's `chat_message_completed` event. Mirrors what the
          // decopilot harness does via `extras.onUsageAggregated` —
          // without this, posthog shows zeroed token counts for CLI
          // threads. CLI harnesses may be invoked without
          // `processLocal` (e.g., from a remote runner), so the call is
          // conditional.
          const totals = usageAcc.totalTokens();
          input.processLocal?.onUsageAggregated(totals);
        }
      },
    };
  },
};
