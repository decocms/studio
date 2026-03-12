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
 */
const TITLE_TIMEOUT_MS = 2500;

export async function genTitle(config: {
  abortSignal: AbortSignal;
  model: LanguageModelV3;
  userMessage: string;
}): Promise<string | null> {
  const { abortSignal, model, userMessage } = config;

  // Create a local abort controller for title generation only
  const titleAbortController = new AbortController();

  // Abort title generation if parent stream is aborted
  const onParentAbort = () => titleAbortController.abort();
  abortSignal.addEventListener("abort", onParentAbort, { once: true });

  // Abort title generation after timeout (doesn't affect parent stream)
  const timeoutId = setTimeout(() => {
    titleAbortController.abort();
  }, TITLE_TIMEOUT_MS);

  try {
    const result = await generateText({
      model,
      system: TITLE_GENERATOR_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      maxOutputTokens: 60,
      temperature: 0.2,
      abortSignal: titleAbortController.signal,
    });

    // Extract just the first line, clean up any formatting
    const rawTitle = result.text.trim();
    const firstLine = rawTitle.split("\n")[0] ?? rawTitle;
    const title = firstLine
      .replace(/^["']|["']$/g, "") // Remove quotes
      .replace(/^(Title:|title:)\s*/i, "") // Remove "Title:" prefix
      .replace(/[.!?]$/, "") // Remove trailing punctuation
      .slice(0, 60) // Max 60 chars
      .trim();

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
    clearTimeout(timeoutId);
    abortSignal.removeEventListener("abort", onParentAbort);
  }
}
