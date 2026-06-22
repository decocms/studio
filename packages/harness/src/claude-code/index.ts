/**
 * Claude Code harness — wraps the `claude` CLI via
 * `ai-sdk-provider-claude-code`.
 *
 * Unlike Decopilot, this harness:
 *  - Does NOT register built-in tools (the CLI manages its own tools and
 *    reaches mesh's MCP endpoint directly).
 *  - Does NOT build a Decopilot-style system prompt or tool catalog; it only
 *    appends CLI-safe workspace/instruction context through the SDK's
 *    `systemPrompt` preset.
 *  - Supports resume via `input.resumeSessionRef`, derived by the shared
 *    layer (Task 12) from prior
 *    `finish-step.providerMetadata["claude-code"].sessionId`. The harness
 *    just forwards that opaque token to the SDK's `resume` setting.
 *
 * Working-directory resolution: the cluster sends `input.workspace.cwd` as
 * a SYMBOLIC value — either "default" (no checkout, use SDK default) or
 * "/repo" (repo checkout inside the sandbox). The daemon rebases "/repo"
 * onto its own sandbox root before the harness ever sees it, so by the
 * time we reach `effectiveCwd()` the value is already a host-absolute path
 * or the "default" sentinel. `effectiveCwd("default")` returns `undefined`
 * so the CLI subprocess inherits `process.cwd()` from the daemon.
 *
 * Behavior parity with stream-core: the inline call at lines 888–906
 * passes `mcpServers` (single `cms` entry), `toolApprovalLevel`,
 * `isPlanMode`, `resume`, `cwd`, and the CLI preset append prompt — all are
 * forwarded here.
 *
 * The harness yields raw `UIMessageChunk` — including the
 * `finish-step.providerMetadata["claude-code"]` block. The shared stream
 * layer (Task 12) is responsible for extracting the `sessionId` from
 * those chunks and persisting it to message metadata so the next turn
 * can resume.
 */

import { streamText, type UIMessageChunk } from "ai";
import { createClaudeCodeModel, resolveClaudeCodeModelId } from "./model";
import { effectiveCwd } from "../workspace-cwd";
import { extractUserText, prepCliMessages } from "../cli-message-prep";
import { createCliMessageMetadata } from "../cli-stream-metadata";
import { buildCodingWorkspacePrompt } from "../coding-workspace-prompt";
import { buildCurrentContextPrompt } from "../decopilot/system-prompt";
import { mergeTitleResult, shouldGenerateTitle } from "../title-merge";
import { genTitle } from "../decopilot/title-generator";
import { stringifyError } from "../decopilot/stream-error";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";

export function buildClaudeCodeSystemPrompt(input: {
  codingWorkspace?: HarnessStreamInput["codingWorkspace"];
  agentInstructions?: string;
  now?: Date;
}) {
  const parts = [
    buildCodingWorkspacePrompt(input.codingWorkspace),
    input.agentInstructions?.trim()
      ? `<agent-instructions>\n${input.agentInstructions.trim()}\n</agent-instructions>`
      : null,
    buildCurrentContextPrompt(input.now ?? new Date()),
  ].filter((part): part is string => Boolean(part?.trim()));

  if (parts.length === 0) return undefined;
  return {
    type: "preset" as const,
    preset: "claude_code" as const,
    append: parts.join("\n\n"),
  };
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

        // 2. Translate the symbolic workspace.cwd to an SDK option. The daemon
        //    has already rebased "/repo" onto its sandbox root before the
        //    harness runs, so we receive either the rebased absolute path or
        //    the "default" sentinel. `effectiveCwd("default")` → undefined
        //    (SDK default = process.cwd()); any other value passes through
        //    as the CLI subprocess working directory.
        const cwd = effectiveCwd(input.workspace.cwd);

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
        //    Mirrors stream-core lines 888–906 — the CLI options and
        //    preset append prompt are threaded through.
        const systemPrompt = buildClaudeCodeSystemPrompt({
          codingWorkspace: input.codingWorkspace,
          agentInstructions:
            typeof input.virtualMcp.metadata === "object" &&
            input.virtualMcp.metadata !== null &&
            typeof (input.virtualMcp.metadata as { instructions?: unknown })
              .instructions === "string"
              ? (input.virtualMcp.metadata as { instructions: string })
                  .instructions
              : undefined,
        });
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
          systemPrompt,
        });

        // 4. Convert UIMessages to ModelMessages. The AI SDK's
        //    `streamText` validates the prompt via Zod in
        //    `standardizePrompt` and expects `ModelMessage[]`
        //    (`content: ...`), not `UIMessage[]` (`parts: [...]`). See
        //    `apps/mesh/src/harnesses/cli-message-prep.ts` for details —
        //    a previous `as never` cast hid this mismatch and would have
        //    thrown `InvalidPromptError` at runtime.
        const messages = await prepCliMessages(input.messages);

        // 4a. Start title generation with Claude Code's fast model. The
        //     cluster interceptor only persists/broadcasts the result chunk.
        //     Gate (D13): only auto-title an unrenamed thread (title still the
        //     default). CLI harnesses are never subtask producers, so we gate
        //     on title alone. When gated off we skip the model call entirely
        //     and pass the raw stream through unmerged below.
        const needsTitle = shouldGenerateTitle({
          currentThreadTitle: input.currentThreadTitle,
        });
        const titleHandle = needsTitle
          ? genTitle({
              abortSignal: input.signal,
              model: createClaudeCodeModel(
                resolveClaudeCodeModelId("claude-code:haiku"),
                {
                  toolApprovalLevel: "readonly",
                  isPlanMode: true,
                  cwd,
                },
              ),
              userMessage: extractUserText(messages),
            })
          : null;

        // 5. Run streamText. Claude Code's CLI manages its own tools and base
        //    system prompt, so we explicitly DO NOT pass `tools` or `system`.
        //    Context additions are supplied through the SDK model's
        //    `systemPrompt` preset append option. The CLI handles
        //    `experimental_repairToolCall` internally too.
        //
        //    `allowSystemInMessages: true` acknowledges that the
        //    converted ModelMessage[] may contain system-role messages
        //    inherited from prior turns of the UI history (decopilot
        //    threads occasionally carry server-built system blocks).
        //    Those are harmless here because the Claude Code CLI
        //    ignores them in favor of its base prompt plus preset append
        //    context, but without this flag the AI SDK 6.0.182+ emits a noisy
        //    prompt-injection security warning on every turn.
        const result = streamText({
          model: languageModel,
          messages,
          abortSignal: input.signal,
          allowSystemInMessages: true,
        });

        // 6. Pipe UIMessageChunk through. We surface
        //    `codingAgentSessionId` / `codingAgentProvider` at the top of
        //    the message metadata so the shared layer persists them onto
        //    the response message's metadata. Subsequent turns read those
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
        const cliMetadata = createCliMessageMetadata({
          input,
          providerName: "claude-code",
          providerMetadataKey: "claude-code",
          extractSessionId: (metadata) =>
            typeof (metadata as { sessionId?: unknown })?.sessionId === "string"
              ? (metadata as { sessionId: string }).sessionId
              : undefined,
        });
        const uiStream = result.toUIMessageStream({
          messageMetadata: cliMetadata,
        });

        try {
          const merged = titleHandle
            ? mergeTitleResult(uiStream, titleHandle)
            : uiStream;
          for await (const chunk of merged) {
            yield chunk;
          }
        } catch (err) {
          // The dispatch route (packages/sandbox/daemon/routes/dispatch.ts)
          // also logs the crash, but logging here captures the resolved
          // cwd/model context at the point of failure — the most useful
          // detail when the CLI subprocess fails to start.
          console.error(
            `[claude-code] stream error model=${sdkModelId} cwd=${cwd ?? "(default)"}:`,
            stringifyError(err),
          );
          throw err;
        }
      },
    };
  },
};
