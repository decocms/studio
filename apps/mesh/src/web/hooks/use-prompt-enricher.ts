import { useProjectContext } from "@decocms/mesh-sdk";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

/** Minimum draft length before the Iterate action is enabled. */
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
 * Imperative prompt enrichment. Unlike a query, nothing runs until the caller
 * invokes `enrich()` (wired to the explicit Iterate button) — there is no
 * debounce or auto-run. Live partials are exposed via `text` / `reasoning`;
 * the promise resolves with the final text so the caller can commit it.
 */
export function usePromptEnricher(): PromptEnricher {
  const { org } = useProjectContext();
  const orgSlug = org.slug;
  const abortRef = useRef<AbortController | null>(null);
  const [live, setLive] = useState<{ text: string; reasoning: string }>({
    text: "",
    reasoning: "",
  });

  const mutation = useMutation({
    mutationFn: async (draft: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLive({ text: "", reasoning: "" });

      let text = "";
      let reasoning = "";
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

      // Idle-completion guard: the local dev tunnel sometimes delivers every
      // token but withholds the trailing `finish` frame + connection close, so
      // the loop below would otherwise hang forever ("Enriching…" with the full
      // text already shown). Once tokens stop arriving for IDLE_MS, we stop and
      // complete with what we have. Armed only after the first frame, so a slow
      // time-to-first-token doesn't cut us off early.
      const IDLE_MS = 2000;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleDone = false;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleDone = true;
          ac.abort();
        }, IDLE_MS);
      };

      try {
        for await (const frame of readSseFrames(resp.body)) {
          if (ac.signal.aborted) break;
          if (frame.type === "text") {
            text += frame.text;
            setLive({ text, reasoning });
            armIdle();
          } else if (frame.type === "reasoning") {
            reasoning += frame.text;
            setLive({ text, reasoning });
            armIdle();
          } else if (frame.type === "error") {
            throw new Error(frame.message);
          } else if (frame.type === "finish") {
            break;
          }
        }
      } catch (e) {
        // Swallow aborts (idle-completion, user cancel, or a superseding run) —
        // they're expected stops, not failures. Re-throw only genuine errors
        // (e.g. an `error` frame or a mid-stream network drop).
        const isAbort =
          (e as { name?: string })?.name === "AbortError" || ac.signal.aborted;
        if (!idleDone && !isAbort) throw e;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      return { text, reasoning };
    },
  });

  return {
    enrich: (draft: string) => mutation.mutateAsync(draft),
    cancel: () => {
      abortRef.current?.abort();
      mutation.reset();
      setLive({ text: "", reasoning: "" });
    },
    status: mutation.isPending
      ? "streaming"
      : mutation.isError
        ? "error"
        : mutation.isSuccess
          ? "done"
          : "idle",
    text: live.text,
    reasoning: live.reasoning,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
