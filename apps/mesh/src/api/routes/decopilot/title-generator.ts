/**
 * Decopilot Title Generator
 *
 * Generates conversation titles in the background using LLM.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText } from "ai";

import { TITLE_GENERATOR_PROMPT } from "./constants";

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

  const promise = (async (): Promise<string | null> => {
    try {
      const result = await generateText({
        model,
        system: TITLE_GENERATOR_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: 60,
        temperature: 0.2,
        abortSignal: titleAbortController.signal,
      });

      // Strip markdown code fences if present, then try JSON parse
      const cleaned = result.text
        .trim()
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/, "")
        .trim();

      let title: string;

      try {
        const parsed = JSON.parse(cleaned);
        title = typeof parsed.title === "string" ? parsed.title : cleaned;
      } catch {
        // Fallback: extract first line and clean up formatting
        const firstLine = cleaned.split("\n")[0] ?? cleaned;
        title = firstLine;
      }

      title = title
        .replace(/^["']|["']$/g, "") // Remove quotes
        .replace(/^(Title:|title:)\s*/i, "") // Remove "Title:" prefix
        .replace(/^```.*$/gm, "") // Remove any remaining fence lines
        .replace(/[{}[\]]/g, "") // Remove JSON braces/brackets
        .replace(/[.!?]$/, "") // Remove trailing punctuation
        .slice(0, 60) // Max 60 chars
        .trim();

      // If cleanup left nothing useful, don't set a broken title
      if (!title || /^[\s"':{}[\],]+$/.test(title)) return null;

      return title;
    } catch (error) {
      const err = error as Error;
      if (err.name === "AbortError") {
        console.warn(
          "[decopilot:title] Title generation aborted (timeout or parent abort)",
        );
      } else {
        console.error(
          "[decopilot:title] ❌ Failed to generate title:",
          err.message,
        );
      }
      return null;
    } finally {
      clearTimeout(graceTimeoutId);
      abortSignal.removeEventListener("abort", onParentAbort);
    }
  })();

  return { promise, finish };
}
