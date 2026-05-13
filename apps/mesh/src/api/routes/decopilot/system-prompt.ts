/**
 * System-prompt assembly helpers for decopilot.
 *
 * stream-core.ts is the canonical place where the system-prompt parts are
 * collected (basePrompt, planModePrompt, …, agentPrompt). This module
 * takes that already-ordered, already-filtered array of strings and
 *   (a) wraps each part as an AI-SDK `SystemMessage`,
 *   (b) attaches Anthropic `cacheControl: { ephemeral, 5m }` on the two
 *       cut points so the prefix can be reused across turns, and
 *   (c) appends a per-request, NON-cached `<current-context>` block
 *       carrying the date/time so request-time content never invalidates
 *       the cached prefix.
 *
 * The Anthropic cache markers are namespaced under `providerOptions
 * .anthropic`; non-Anthropic providers ignore the field. OpenRouter
 * specifically reads the same field as a fallback (see
 * `@openrouter/ai-sdk-provider/dist/index.js` getCacheControl) so the
 * markers propagate through OpenRouter routes too.
 */

import type { Todo } from "./built-in-tools/todo-write";
import { EPHEMERAL_5M } from "./cache-instrumentation";

export interface SystemMessage {
  role: "system";
  content: string;
  providerOptions?: {
    anthropic?: {
      cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" };
    };
  };
}

/**
 * Per-request, non-cached system prompt content.
 *
 * Anything that varies between requests but is needed in the system layer
 * lives here — kept outside the cached prefix so it doesn't invalidate
 * Anthropic cache breakpoints or OpenAI/Gemini automatic prefix caches.
 */
export function buildCurrentContextPrompt(now: Date): string {
  const iso = now.toISOString();
  return `<current-context>
Current date: ${iso.slice(0, 10)}
Current time: ${iso.slice(11, 16)} UTC
</current-context>`;
}

/**
 * Per-request, non-cached system prompt block carrying the current
 * todo list. Returns null when the list is empty so the caller can
 * skip the append entirely. Lives alongside <current-context> in the
 * non-cached system tail — never wrapped in cache markers.
 */
export function buildCurrentTodosPrompt(todos: readonly Todo[]): string | null {
  if (todos.length === 0) return null;
  const lines = todos.map((t) => {
    const label = t.status === "in_progress" ? t.activeForm : t.content;
    return `- [${t.status}] ${label}`;
  });
  return `<current-todos>\n${lines.join("\n")}\n</current-todos>`;
}

const EPHEMERAL_5M_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: EPHEMERAL_5M },
};

/**
 * Wrap stream-core's `string[]` of stable, byte-stable system-prompt
 * parts into AI-SDK system messages, attaching Anthropic cache markers
 * on the two cut points and appending a non-cached current-context tail.
 *
 *   parts:    [p0, p1, …, pN-2, pN-1]
 *   returned: [
 *     { role: "system", content: p0 },                                    // …
 *     { role: "system", content: pN-2, providerOptions: ephemeral_5m },   // ← BP1
 *     { role: "system", content: pN-1, providerOptions: ephemeral_5m },   // ← BP2
 *     { role: "system", content: <current-context> },                     // uncached
 *   ]
 *
 * When `parts` has fewer than 2 items, BP1 collapses (or both BPs
 * collapse if there's only 1). The current-context tail is always
 * appended.
 */
export function buildSystemMessages(
  parts: string[],
  now: Date,
): SystemMessage[] {
  const out: SystemMessage[] = [];
  const bp2Idx = parts.length - 1;
  const bp1Idx = parts.length - 2;
  for (let i = 0; i < parts.length; i++) {
    const isCacheCut = i === bp1Idx || i === bp2Idx;
    out.push({
      role: "system",
      content: parts[i]!,
      ...(isCacheCut ? { providerOptions: EPHEMERAL_5M_PROVIDER_OPTIONS } : {}),
    });
  }
  out.push({
    role: "system",
    content: buildCurrentContextPrompt(now),
  });
  return out;
}
