/**
 * Codex harness — wraps the `codex` app-server via
 * `ai-sdk-provider-codex-cli`.
 *
 * Unlike Decopilot, this harness:
 *  - Does NOT register built-in tools (the CLI manages its own tools and
 *    reaches studio's MCP endpoint directly).
 *  - Does NOT build a system prompt (the CLI has its own).
 *  - Supports resume: each turn spawns a fresh codex app-server process, but
 *    `resume: input.harness.sessionId` reloads the on-disk thread (the app
 *    server persists rollouts under HOME, which survives the per-turn
 *    subprocess on the long-lived desktop daemon). `threadMode: "persistent"`
 *    (set in createCodexModel) makes the first turn's thread non-ephemeral so
 *    it can be resumed next turn.
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
 * `packages/harness/src/codex/model/index.ts`) and not
 * options the call site controls.
 *
 * The harness yields raw `UIMessageChunk` — including the
 * `finish-step.providerMetadata["codex-app-server"]` block. The shared
 * stream layer extracts the Codex thread id from that metadata and feeds
 * it back as `input.harness.sessionId` on the next turn.
 */

import { streamText, type UIMessageChunk } from "ai";
import { generateMessageId } from "../message-id";
import { createCodexModel, resolveCodexModelId } from "./model";
import { buildCodingWorkspacePrompt } from "../coding-workspace-prompt";
import { localWorkspaceIsDecoSite } from "../coding-workspace-deco";
import { effectiveCwd } from "../workspace-cwd";
import { extractUserText, prepCliMessages } from "../cli-message-prep";
import { createCliMessageMetadata } from "../cli-stream-metadata";
import {
  CliSessionExpiredError,
  isStaleSessionError,
} from "../cli-session-error";
import { mergeTitleResult, shouldGenerateTitle } from "../title-merge";
import { buildCurrentContextPrompt } from "../current-context-prompt";
import { NO_BACKGROUND_TASKS_PROMPT } from "../no-background-tasks-prompt";
import { genTitle } from "../title-generator";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";

export function buildCodexModelOptions(
  input: HarnessStreamInput,
  cwd: string | undefined,
  developerInstructions: string | undefined,
): Parameters<typeof createCodexModel>[1] {
  return {
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
    cwd,
    developerInstructions,
    resume: input.harness.sessionId,
  };
}

export function buildCodexDeveloperInstructions(input: {
  workspace?: HarnessStreamInput["workspace"];
  agentInstructions?: string;
  now?: Date;
}): string | undefined {
  const parts = [
    buildCodingWorkspacePrompt(
      input.workspace
        ? {
            ...input.workspace,
            isDecoSite: localWorkspaceIsDecoSite(input.workspace.cwd),
          }
        : input.workspace,
    ),
    input.agentInstructions?.trim()
      ? `<agent-instructions>\n${input.agentInstructions.trim()}\n</agent-instructions>`
      : null,
    NO_BACKGROUND_TASKS_PROMPT,
    buildCurrentContextPrompt(input.now ?? new Date()),
  ].filter((part): part is string => Boolean(part?.trim()));

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export const codexHarnessFactory: HarnessFactory = {
  id: "codex",
  create(_ctx: HarnessContext): Harness {
    return {
      id: "codex",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        // 1. Resolve the composite `codex:<model>` id to the SDK model
        //    name (e.g. `gpt-5.6-terra`). Mirrors stream-core line 922.
        const sdkModelId = resolveCodexModelId(input.models.thinking.id);

        // 2. Translate the workspace cwd to an SDK option. `null` means no
        //    override (SDK default = process.cwd()); "/repo" passes through
        //    unless a desktop daemon has already rebased it to its sandbox
        //    checkout path before calling the harness.
        const cwd = effectiveCwd(input.workspace.cwd);
        const developerInstructions = buildCodexDeveloperInstructions({
          workspace: input.workspace,
          agentInstructions: input.agent.instructions,
        });

        // Diagnostics: on the user-desktop path this runs inside the spawned
        // sandbox daemon (stdout inherited by `deco link`), so these lines
        // surface in the link terminal. They pin the three most common
        // failure causes for a `decopilot.finish: failed` with no other
        // signal — wrong cwd (CLI runs outside the checkout), an
        // unreachable MCP endpoint, or a bad model id.
        console.log(
          `[codex] stream start model=${sdkModelId} cwd=${cwd ?? "(default)"} mcpUrl=${input.mcp.url} mode=${input.mode}`,
        );

        // 3. Build the Codex language model. The MCP URL + headers are
        //    already minted by the shared layer (it owns the
        //    temp-API-key lifecycle); the harness just forwards them.
        //    Mirrors stream-core lines 921–937 — all three options
        //    (mcpServers, toolApprovalLevel, isPlanMode) are threaded
        //    through.
        //
        //    Note the transport key is `transport` (not `type`) — this
        //    matches the `createCodexModel` signature at
        //    `packages/harness/src/codex/model/index.ts`
        //    line 18, where http servers are normalized to the codex
        //    SDK's `httpHeaders` shape internally.
        const { model, provider } = createCodexModel(
          sdkModelId,
          buildCodexModelOptions(input, cwd, developerInstructions),
        );

        try {
          // 3. Convert UIMessages to ModelMessages. The AI SDK's
          //    `streamText` validates the prompt via Zod in
          //    `standardizePrompt` and expects `ModelMessage[]`
          //    (`content: ...`), not `UIMessage[]` (`parts: [...]`).
          //    See `packages/harness/src/cli-message-prep.ts` for
          //    details — a previous `as never` cast hid this mismatch
          //    and would have thrown `InvalidPromptError` at runtime.
          const messages = await prepCliMessages([input.userMessage]);

          // 3a. Start title generation with Codex's fast model. This uses a
          //     separate app-server process so title generation can run in
          //     parallel with the main Codex stream and close independently.
          //     Gate (D13): only auto-title an unrenamed thread (title still
          //     the default). CLI harnesses are never subtask producers, so we
          //     gate on title alone. When gated off we skip spawning the title
          //     app-server entirely and pass the raw stream through unmerged.
          const needsTitle = shouldGenerateTitle({
            currentThreadTitle: input.currentThreadTitle,
          });
          const titleSetup = needsTitle
            ? (() => {
                const { model: titleModel, provider: titleProvider } =
                  createCodexModel(resolveCodexModelId("codex:gpt-5.6-luna"), {
                    toolApprovalLevel: "readonly",
                    isPlanMode: true,
                    cwd,
                  });
                const handle = genTitle({
                  abortSignal: input.signal,
                  models: [() => titleModel],
                  userMessage: extractUserText(messages),
                });
                const closed = handle.promise.finally(() =>
                  titleProvider.close().catch(() => {}),
                );
                return { handle, closed };
              })()
            : null;
          const titleHandle = titleSetup?.handle ?? null;

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
          //    of the message metadata so the shared layer persists them
          //    onto the response message's metadata. Subsequent turns read
          //    those fields back to recover `input.harness.sessionId`.
          //
          //    We also forward cumulative `usage` (with cache token
          //    breakdown + OpenRouter cost) on both `finish-step` and
          //    `finish` chunks via the shared `usage-accumulator`. The
          //    pre-refactor stream-core (2073a39b8, lines 1411–1571)
          //    maintained the same accumulator inline; replicating it
          //    here keeps the UI's token-count tooltip working for
          //    Codex threads. Without this, the UI sees raw per-step
          //    usage and loses cache-read/write detail.
          const cliMetadata = createCliMessageMetadata({
            input,
            providerName: "codex",
            providerMetadataKey: "codex-app-server",
            extractSessionId: (metadata) =>
              typeof (metadata as { threadId?: unknown })?.threadId === "string"
                ? (metadata as { threadId: string }).threadId
                : undefined,
          });
          const uiStream = result.toUIMessageStream({
            generateMessageId,
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
            if (input.harness.sessionId && isStaleSessionError(err)) {
              throw new CliSessionExpiredError(err);
            }
            throw err;
          } finally {
            titleHandle?.finish();
            await titleSetup?.closed.catch(() => {});
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
