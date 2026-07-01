import { useProjectContext } from "@decocms/mesh-sdk";
import { useRef, useState } from "react";

/** Minimum draft length before the Improve action is enabled. */
export const PROMPT_EXPLORER_MIN_CHARS = 10;

type Frame =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "finish" };

/** Parse an SSE byte stream into our `{type,...}` JSON frames. */
async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as Frame;
        } catch {
          // skip malformed frame
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type PromptEnricherStatus = "idle" | "streaming" | "done" | "error";

export interface PromptEnricher {
  /** Stream an enriched version of `draft`; resolves with the final text. */
  enrich: (draft: string) => Promise<{ text: string; reasoning: string }>;
  /** Abort any in-flight stream and reset state. */
  cancel: () => void;
  status: PromptEnricherStatus;
  /** Live streamed text (accumulates during a run). */
  text: string;
  /** Live streamed reasoning (accumulates during a run). */
  reasoning: string;
  error: string | null;
}

/**
 * Imperative prompt enrichment. Nothing runs until the caller invokes
 * `enrich()` (wired to the explicit Improve button) — there is no debounce or
 * auto-run. Live partials are exposed via `text` / `reasoning`; the promise
 * resolves with the final text so the caller can commit it.
 *
 * State is driven by plain `useState` (NOT react-query): the UI reads `status`
 * every render, and a value read off a react-query mutation result goes stale
 * under the React Compiler (the derived value gets memoized against the
 * referentially-stable result object, so `isPending` never updates and the UI
 * hangs on "streaming" forever even after the request completes). A `useState`
 * the compiler can track avoids that entirely.
 *
 * The stream terminates on the server's `finish` frame or on connection close
 * (`done`) — both reliable; no idle/timeout guard is needed.
 */
export function usePromptEnricher(): PromptEnricher {
  const { org } = useProjectContext();
  const orgSlug = org.slug;
  const abortRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<PromptEnricherStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ text: string; reasoning: string }>({
    text: "",
    reasoning: "",
  });

  const enrich = async (draft: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Only the most-recent run owns the shared status/live state; a superseded
    // run must not stomp it when it later unwinds.
    const isCurrent = () => abortRef.current === ac;

    setStatus("streaming");
    setError(null);
    setLive({ text: "", reasoning: "" });

    let text = "";
    let reasoning = "";
    try {
      const resp = await fetch(
        `/api/${encodeURIComponent(orgSlug)}/prompt-explorer/stream`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          credentials: "include",
          body: JSON.stringify({ draft }),
          signal: ac.signal,
        },
      );
      if (!resp.ok || !resp.body) {
        throw new Error(`Prompt enrichment failed (${resp.status})`);
      }

      for await (const frame of readSseFrames(resp.body)) {
        if (ac.signal.aborted) break;
        if (frame.type === "text") {
          text += frame.text;
          if (isCurrent()) setLive({ text, reasoning });
        } else if (frame.type === "reasoning") {
          reasoning += frame.text;
          if (isCurrent()) setLive({ text, reasoning });
        } else if (frame.type === "error") {
          throw new Error(frame.message);
        } else if (frame.type === "finish") {
          break;
        }
      }
      if (isCurrent()) setStatus("done");
      return { text, reasoning };
    } catch (e) {
      // An abort (user cancel or a superseding run) is an expected stop, not a
      // failure — settle quietly with whatever streamed so far.
      const isAbort =
        (e as { name?: string })?.name === "AbortError" || ac.signal.aborted;
      if (isAbort) {
        if (isCurrent()) setStatus("idle");
        return { text, reasoning };
      }
      if (isCurrent()) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Failed to enrich prompt");
      }
      throw e;
    }
  };

  return {
    enrich,
    cancel: () => {
      abortRef.current?.abort();
      abortRef.current = null;
      setStatus("idle");
      setError(null);
      setLive({ text: "", reasoning: "" });
    },
    status,
    text: live.text,
    reasoning: live.reasoning,
    error,
  };
}
