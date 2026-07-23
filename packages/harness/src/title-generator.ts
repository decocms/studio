/**
 * Decopilot Title Generator
 *
 * Generates conversation titles in the background using LLM.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { retry } from "@decocms/shared/std";
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
Bad (wrong case): Fix Login Button On Mobile

Respond with a JSON object containing the title.`;

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

// Hard cap on how long we wait for the title model before falling back to the
// clamped user message. Independent of the main stream: a slow/hung title model
// (e.g. codex's separate title app-server) must NOT keep the thread on "New
// chat" for the whole run — it should surface the deterministic fallback
// promptly so a title appears soon after submit.
const TITLE_GEN_TIMEOUT_MS = 20_000;
const FALLBACK_TITLE_MAX_CHARS = 32;
// Total title-generation attempts before falling back. Each attempt uses the
// next model in `models` (clamped to the last), so a fast/cheap model is tried
// first and a slower/stronger one only if it keeps failing.
const TITLE_GEN_MAX_ATTEMPTS = 3;

export function genTitle(config: {
  /** Optional: aborts title generation when the parent stream is cancelled.
   *  Undefined on the desktop/pull path, where the harness runs from a
   *  serialized wire input that cannot carry a (non-serializable) AbortSignal. */
  abortSignal?: AbortSignal;
  /** Ordered fallback chain, fast/cheap first — each entry is a lazy factory
   *  so an unbuildable model fails only its own attempt (never at call time).
   *  Attempt N uses `models[N]`, clamped to the last entry once exhausted. */
  models: Array<() => LanguageModelV3>;
  userMessage: string;
  /** Override the self-timeout (ms) before falling back to the clamped user
   *  message. Defaults to {@link TITLE_GEN_TIMEOUT_MS}. Tests pass a tiny value. */
  timeoutMs?: number;
  /** Override the attempt cap. Defaults to {@link TITLE_GEN_MAX_ATTEMPTS}. */
  maxAttempts?: number;
}): { promise: Promise<string | null>; finish: () => void } {
  const { abortSignal, models, userMessage } = config;
  const timeoutMs = config.timeoutMs ?? TITLE_GEN_TIMEOUT_MS;
  const maxAttempts = Math.max(1, config.maxAttempts ?? TITLE_GEN_MAX_ATTEMPTS);

  const titleAbortController = new AbortController();

  // Fallback used when the LLM call errors or produces unusable output.
  // Spec: take the literal first 32 characters of the user message, trim,
  // and fall through to "New chat" if there's no usable letter/digit.
  // Short, deterministic, and cheap; the user can rename the thread at
  // any time. 32 chars was picked over the previous 60-char first-line
  // shape to keep failed/empty titles visually compact in the sidebar.
  const fallbackTitle = (() => {
    const candidate = userMessage.slice(0, FALLBACK_TITLE_MAX_CHARS).trim();
    return hasUsableText(candidate) ? candidate : "New chat";
  })();

  // Guaranteed-settlement latch. The timers/parent-abort below only *signal* an
  // abort on `titleAbortController`; whether the in-flight `generateObject`
  // actually rejects depends on the provider honoring that signal — and `retry`
  // observes the abort only *between* attempts, never during an in-flight call.
  // A hung title app-server that ignores the signal would otherwise leave the
  // returned promise pending forever, hanging the parent run's drain loop (which
  // gates stream completion on the title settling). Racing the generation against
  // this latch caps settlement at the timeout regardless of provider behavior.
  // ponytail: the ignored in-flight request leaks until it settles or the process
  // exits — acceptable; the alternative is hanging the whole run.
  let settleLatch!: (v: string | null) => void;
  const latch = new Promise<string | null>((resolve) => {
    settleLatch = resolve;
  });

  // Abort title generation if parent stream is aborted. `abortSignal` is
  // optional-at-runtime: on the desktop/pull path the serialized wire input
  // omits the (non-serializable) AbortSignal, and a caller may legitimately
  // have nothing to tie lifetime to. Guard so a missing signal degrades to "no
  // parent abort wiring" instead of throwing `addEventListener of undefined`.
  // Cancelled run → resolve the latch with null so no title is emitted.
  const onParentAbort = () => {
    titleAbortController.abort();
    settleLatch(null);
  };
  abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  let graceTimeoutId: ReturnType<typeof setTimeout> | undefined;

  // Self-timeout: cap title generation so a slow/hung title model falls back to
  // the clamped user message promptly (≈ right after submit) instead of only
  // resolving when the main stream ends. Fires regardless of stream lifetime.
  const selfTimeoutId = setTimeout(() => {
    titleAbortController.abort();
    settleLatch(fallbackTitle);
  }, timeoutMs);

  // Called when the main LLM stream finishes — gives the title a grace
  // period to complete, then aborts so onFinish doesn't hang.
  const finish = () => {
    graceTimeoutId = setTimeout(() => {
      titleAbortController.abort();
      settleLatch(fallbackTitle);
    }, POST_STREAM_GRACE_MS);
  };

  const genPromise = (async (): Promise<string | null> => {
    // No model to try → deterministic fallback, never a broken title.
    if (models.length === 0) return fallbackTitle;
    try {
      let attempt = -1;
      const result = await retry(
        () => {
          attempt++;
          // Guarded non-empty above, so this index is always in range. Build
          // the model lazily here so a factory that throws counts as a failed
          // attempt (retried / rotated) rather than crashing the caller.
          const model = models[Math.min(attempt, models.length - 1)]!();
          return generateObject({
            model,
            schema: TITLE_SCHEMA,
            system: TITLE_GENERATOR_PROMPT,
            messages: [{ role: "user", content: userMessage }],
            temperature: 0.2,
            abortSignal: titleAbortController.signal,
          });
        },
        {
          maxAttempts,
          minTimeout: 200,
          maxTimeout: 2_000,
          // Don't retry a cancel/timeout — only genuine model failures.
          isRetriable: (err) => (err as Error)?.name !== "AbortError",
          signal: titleAbortController.signal,
        },
      );

      const title = result.object.title
        .replace(/[.!?]$/, "") // Remove trailing punctuation
        .slice(0, 60) // Max 60 chars
        .trim();

      // Reject empty or all-punctuation strings — fall back to user message
      if (!hasUsableText(title)) return fallbackTitle;

      return title;
    } catch (error) {
      // On exhaustion `retry` throws a RetryError wrapping the last failure in
      // `.cause`; on abort it rethrows the AbortError directly. Unwrap so the
      // abort-vs-failure branch below sees the real error either way.
      const err = ((error as { cause?: unknown }).cause ?? error) as Error;
      if (err.name === "AbortError") {
        // Parent stream was cancelled (user hit stop) → do NOT title a cancelled
        // run; emit nothing.
        if (abortSignal?.aborted) {
          console.warn(
            "[decopilot:title] Title generation aborted (parent abort)",
          );
          return null;
        }
        // Otherwise it timed out (self-timeout or post-stream grace). Surface the
        // deterministic clamped-user-message fallback so the thread never stays
        // on "New chat" — NOT null, which would emit no title chunk.
        console.warn(
          "[decopilot:title] Title generation timed out; using fallback",
        );
        return fallbackTitle;
      }
      console.error(
        "[decopilot:title] ❌ Failed to generate title:",
        err.message,
      );
      return fallbackTitle;
    } finally {
      clearTimeout(graceTimeoutId);
      clearTimeout(selfTimeoutId);
      abortSignal?.removeEventListener("abort", onParentAbort);
    }
  })();

  // Whichever settles first wins. `genPromise` never rejects (it catches every
  // failure and returns a value), so racing it against the latch can only ever
  // resolve — never leave an unhandled rejection dangling.
  const promise = Promise.race([genPromise, latch]);

  return { promise, finish };
}
