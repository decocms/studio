import { useEffect, useState } from "react";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { guardToolInvariant } from "../../../store/tool-invariant-guard";

/** Parse an SSE byte stream into the `UIMessageChunk`s the AI SDK reader folds. */
function sseToChunkStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
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
              controller.enqueue(JSON.parse(data) as UIMessageChunk);
            } catch {
              // skip malformed frame
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/**
 * Tails a backgrounded subtask's OWN live stream (`decopilot.stream.<jobId>`,
 * served by `GET …/threads/:threadId/jobs/:jobId/stream`) and folds it into the
 * subagent run's messages — independent of the thread's own stream. Active only
 * while `enabled` (the subtask panel is open); on a completed/purged run the
 * tail yields nothing and the caller falls back to the persisted nested rows.
 */
export function useSubtaskStream(args: {
  orgSlug: string;
  threadId: string;
  jobId: string | undefined;
  enabled: boolean;
}): { messages: UIMessage[]; streaming: boolean } {
  const { orgSlug, threadId, jobId, enabled } = args;
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [streaming, setStreaming] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- an SSE subscription is a mount/enable-scoped side effect; a ref-bound effect is the natural fit (mirrors useTopSentinel in chat/index.tsx).
  useEffect(() => {
    if (!enabled || !jobId) return;
    const abort = new AbortController();
    setMessages([]);
    setStreaming(true);
    void (async () => {
      try {
        const resp = await fetch(
          `/api/${encodeURIComponent(orgSlug)}/decopilot/threads/${encodeURIComponent(threadId)}/jobs/${encodeURIComponent(jobId)}/stream`,
          {
            headers: { accept: "text/event-stream" },
            credentials: "include",
            signal: abort.signal,
          },
        );
        if (!resp.ok || !resp.body) return;
        // Same tool-invocation guard as the main thread reader: a reconstructed
        // subtask stream can deliver a tool's output without its input part,
        // which would otherwise throw and silently truncate the subtask view.
        for await (const msg of readUIMessageStream({
          stream: guardToolInvariant(sseToChunkStream(resp.body), undefined),
        })) {
          if (abort.signal.aborted) return;
          setMessages([msg]);
        }
      } catch {
        // aborted / network drop — keep whatever folded so far
      } finally {
        if (!abort.signal.aborted) setStreaming(false);
      }
    })();
    return () => abort.abort();
  }, [enabled, jobId, threadId, orgSlug]);

  return { messages, streaming };
}
