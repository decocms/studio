/**
 * Decopilot Title Generator
 *
 * Generates conversation titles in the background using LLM.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateObject } from "ai";
import { z } from "zod";

const TITLE_SCHEMA = z.object({
  title: z.string().describe("A concise, sentence-case title (3-7 words)"),
});

const TITLE_GENERATOR_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this session. Use sentence case: capitalize only the first word and proper nouns.

Good examples:
- Fix login button on mobile
- Add OAuth authentication
- Query product catalog data
- Set up event subscriptions

Bad (too vague): Help with task
Bad (too long): Investigate and fix the issue where the login button does not respond on mobile devices
Bad (wrong case): Fix Login Button On Mobile`;

// A title is usable only if it contains at least one letter or number in any
// script. Unicode-aware (\p{L}\p{N}) so non-Latin titles (CJK, Arabic, etc.)
// aren't rejected the way ASCII-only \w would.
const hasUsableText = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);

/**
 * Generate a short title for the conversation in the background.
 *
 * Title generation lives as long as the parent stream. When the stream
 * finishes, the caller should call `finish()` — this starts a short grace
 * period so the title LLM can still complete, but won't block teardown
 * indefinitely.
 */
const POST_STREAM_GRACE_MS = 10_000;

export function genTitle(config: {
  abortSignal: AbortSignal;
  model: LanguageModelV3;
  userMessage: string;
}): { promise: Promise<string | null>; finish: () => void } {
  const { abortSignal, model, userMessage } = config;

  const titleAbortController = new AbortController();

  // Abort title generation if parent stream is aborted
  const onParentAbort = () => titleAbortController.abort();
  abortSignal.addEventListener("abort", onParentAbort, { once: true });

  let graceTimeoutId: ReturnType<typeof setTimeout> | undefined;

  // Called when the main LLM stream finishes — gives the title a grace
  // period to complete, then aborts so onFinish doesn't hang.
  const finish = () => {
    graceTimeoutId = setTimeout(() => {
      titleAbortController.abort();
    }, POST_STREAM_GRACE_MS);
  };

  // Fallback used when the LLM call errors or produces unusable output.
  // Spec: take the literal first 10 characters of the user message, trim,
  // and fall through to "New chat" if there's no usable letter/digit.
  // Short, deterministic, and cheap; the user can rename the thread at
  // any time. 10 chars was picked over the previous 60-char first-line
  // shape to keep failed/empty titles visually compact in the sidebar.
  const fallbackTitle = (() => {
    const candidate = userMessage.slice(0, 10).trim();
    return hasUsableText(candidate) ? candidate : "New chat";
  })();

  const promise = (async (): Promise<string | null> => {
    try {
      const result = await generateObject({
        model,
        schema: TITLE_SCHEMA,
        system: TITLE_GENERATOR_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.2,
        abortSignal: titleAbortController.signal,
      });

      const title = result.object.title
        .replace(/[.!?]$/, "") // Remove trailing punctuation
        .slice(0, 60) // Max 60 chars
        .trim();

      // Reject empty or all-punctuation strings — fall back to user message
      if (!hasUsableText(title)) return fallbackTitle;

      return title;
    } catch (error) {
      const err = error as Error;
      if (err.name === "AbortError") {
        console.warn(
          "[decopilot:title] Title generation aborted (timeout or parent abort)",
        );
        return null;
      }
      console.error(
        "[decopilot:title] ❌ Failed to generate title:",
        err.message,
      );
      return fallbackTitle;
    } finally {
      clearTimeout(graceTimeoutId);
      abortSignal.removeEventListener("abort", onParentAbort);
    }
  })();

  return { promise, finish };
}
