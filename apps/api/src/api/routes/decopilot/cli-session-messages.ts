import type { HarnessId } from "@/harnesses/lib/types";
import { type CliProvider, cliProviderName } from "@/harnesses/lib/cli-harness";
import type { ChatMessage } from "./types";

// `cliProviderName` is the single source of truth for the `HarnessId → provider`
// map (shared with the harness write side via `@/harnesses/lib/cli-harness`).
// Re-exported so this module stays the one-stop place for CLI session-ref/delta
// helpers.
export { cliProviderName };

interface CliSessionMeta {
  codingAgentSessionId?: string;
  codingAgentProvider?: string;
}

/** Index of the most recent assistant message carrying a session id for this
 *  harness's provider, or -1 if none. */
function lastAnchorIndex(
  messages: ChatMessage[],
  provider: CliProvider,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const meta = msg?.metadata as CliSessionMeta | undefined;
    if (
      msg?.role === "assistant" &&
      meta?.codingAgentSessionId &&
      meta?.codingAgentProvider === provider
    ) {
      return i;
    }
  }
  return -1;
}

/** Most-recent on-disk session id for this harness, for resume. */
export function resolveCliSessionRef(
  messages: ChatMessage[],
  harnessId: HarnessId,
): string | undefined {
  const provider = cliProviderName(harnessId);
  if (!provider) return undefined;
  const idx = lastAnchorIndex(messages, provider);
  if (idx === -1) return undefined;
  const meta = messages[idx]?.metadata as CliSessionMeta | undefined;
  return meta?.codingAgentSessionId;
}

/** User messages to send this turn: everything after the last session anchor
 *  (normally one). With no anchor (first turn) → all user messages. */
export function computeCliDelta(
  messages: ChatMessage[],
  harnessId: HarnessId,
): ChatMessage[] {
  const provider = cliProviderName(harnessId);
  if (!provider) return messages;
  const idx = lastAnchorIndex(messages, provider);
  const after = idx === -1 ? messages : messages.slice(idx + 1);
  return after.filter((m) => m.role === "user");
}
