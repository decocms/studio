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
 * Working-directory resolution: the cluster used to inject a
 * `processLocal.resolveCwd` callback that mapped to the `host` runner's
 * `localWorkdir(handle)`. That runner has been retired; the cluster no
 * longer supplies a resolver, and this harness falls through to
 * `process.cwd()` on the desktop daemon (spawned with workdir = sandbox
 * path) or to `undefined` (SDK default) inside the cluster.
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
import { createClaudeCodeModel, resolveClaudeCodeModelId } from "./model";
import { extractUserText, prepCliMessages } from "../cli-message-prep";
import { makeTitleInputChunk } from "../title-chunk";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { createUsageAccumulator } from "../usage-accumulator";

/**
 * Compute the Claude Code working directory.
 *
 * Returns `undefined` when the agent has no `githubRepo` (ephemeral
 * agent → SDK default cwd) or no userId is available (defensive).
 *
 * Otherwise:
 *   - Desktop daemon (no `processLocal`): the sandbox daemon is spawned
 *     with `cwd = <appRoot>`, but the cloned repo lives at
 *     `<appRoot>/repo` (see `packages/sandbox/daemon/entry.ts` — it
 *     joins APP_ROOT with "repo" to form `repoDir`). Prefer the env
 *     vars the sandbox sets (`WORKDIR` / `APP_ROOT`) and fall through
 *     to `<cwd>/repo` so Claude Code actually runs inside the
 *     checkout. Final fallback is `process.cwd()` for non-sandbox
 *     environments (e.g. tests, ad-hoc invocations).
 *   - Cluster: no on-disk sandbox to point at after the host runner was
 *     retired, so fall through to `undefined` (SDK default). The
 *     `processLocal.resolveCwd` callback is kept as an extension point
 *     for future cluster-side runners that materialize files locally.
 */
async function resolveClaudeCodeCwd(
  input: HarnessStreamInput,
): Promise<string | undefined> {
  const vmMetadata = input.virtualMcp.metadata as {
    githubRepo?: unknown;
  } | null;
  if (!vmMetadata?.githubRepo) return undefined;
  if (!input.user?.id) return undefined;

  if (!input.processLocal) {
    const appRoot =
      process.env.WORKDIR || process.env.APP_ROOT || process.cwd();
    return `${appRoot.replace(/\/$/, "")}/repo`;
  }

  const resolveCwd = input.processLocal.resolveCwd;
  if (!resolveCwd) return undefined;
  return await resolveCwd();
}

export const claudeCodeHarnessFactory: HarnessFactory = {
  id: "claude-code",
  create(_ctx: HarnessContext): Harness {
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
        const cwd = await resolveClaudeCodeCwd(input);

        // Diagnostics: on the user-desktop path this runs inside the spawned
        // sandbox daemon (stdout inherited by `deco link`), so these lines
        // surface in the link terminal. They pin the three most common
        // failure causes for a `decopilot.finish: failed` with no other
        // signal — wrong cwd (CLI runs outside the checkout), an
        // unreachable MCP endpoint, or a bad model id.
        console.log(
          `[claude-code] stream start model=${sdkModelId} cwd=${cwd ?? "(default)"} mcpUrl=${input.mcp.url} mode=${input.mode} resume=${input.resumeSessionRef ? "yes" : "no"}`,
        );

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

        // 4a. Request cluster-side title generation. The harness emits a
        //     single transient `data-title-input` chunk carrying the user
        //     message text; the dispatch-layer interceptor
        //     (apps/mesh/src/api/routes/decopilot/title-interceptor.ts) runs
        //     genTitle against the cluster's pre-activated provider and writes
        //     back a `data-thread-title` chunk + persists the title. The
        //     harness itself stays title-agnostic so this works identically
        //     for cluster-local and user-desktop runs.
        yield makeTitleInputChunk(extractUserText(messages)) as UIMessageChunk;

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
        } catch (err) {
          // The dispatch route (packages/sandbox/daemon/routes/dispatch.ts)
          // also logs the crash, but logging here captures the resolved
          // cwd/model context at the point of failure — the most useful
          // detail when the CLI subprocess fails to start.
          console.error(
            `[claude-code] stream error model=${sdkModelId} cwd=${cwd ?? "(default)"}:`,
            err,
          );
          throw err;
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
