/**
 * Shared message-shape conversion for CLI harnesses (Claude Code, Codex).
 *
 * CLI harnesses don't run the full decopilot `processConversation` pipeline
 * (which handles `toModelOutput` truncation, todo-write stripping, pending-
 * approval denial, system-prompt splitting, etc.) — they don't carry
 * mesh-side tools into the CLI binary, so most of that work is irrelevant.
 *
 * They DO, however, need basic `UIMessage` -> `ModelMessage` conversion.
 * `input.messages` is typed as `ChatMessage[]` (a `UIMessage` with
 * `parts: [...]`) but `streamText` requires `ModelMessage[]`
 * (`content: string | ModelMessageContent[]`). The AI SDK validates the
 * prompt via Zod in `standardizePrompt` — passing UI-shape messages
 * through unchanged would throw `InvalidPromptError: expected string,
 * received undefined` at the first stream invocation, breaking Claude
 * Code and Codex streams entirely. A previous `as never` cast at the call
 * sites masked the bug at the type level and would have surfaced only at
 * runtime in production.
 *
 * Uses `ignoreIncompleteToolCalls: true` to match the decopilot pipeline
 * at `apps/mesh/src/api/routes/decopilot/conversation.ts:164-167` — if a
 * prior turn left a tool call without a corresponding result (e.g. the
 * stream was aborted mid-tool), we drop it rather than fail conversion.
 *
 * No `tools` option is passed: CLI harnesses don't register mesh-side
 * tools, so there's no `toModelOutput` for the conversion to call.
 */

import { convertToModelMessages, type ModelMessage } from "ai";
import type { ChatMessage } from "./types";

/** Convert harness UIMessages to ModelMessages for CLI harness streamText
 *  calls. See file-level comment for the why. */
export function prepCliMessages(
  messages: ChatMessage[],
): Promise<ModelMessage[]> {
  return convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });
}
