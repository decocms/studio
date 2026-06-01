/**
 * Decopilot Title Generator
 *
 * Generates conversation titles in the background using LLM.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateObject } from "ai";
import { z } from "zod";

import { TITLE_GENERATOR_PROMPT } from "../../api/routes/decopilot/constants";

const TITLE_SCHEMA = z.object({
  title: z.string().describe("A concise, sentence-case title (3-7 words)"),
});

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

  // Always resolves to a usable title: first line of the user message, run
  // through the same sanitization as the model title, or a static default if
  // the message is empty or has no usable text.
  const fallbackTitle = (() => {
    const candidate = (userMessage.split("\n")[0] ?? "")
      .replace(/[.!?]$/, "")
      .slice(0, 60)
      .trim();
    return candidate && /\w/.test(candidate) ? candidate : "New chat";
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
      if (!title || !/\w/.test(title)) return fallbackTitle;

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
