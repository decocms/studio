/**
 * Remote dispatch — cluster → daemon over the unified `proxyDaemonRequest`
 * seam.
 *
 * `SandboxProvider.proxyDaemonRequest(handle, "/dispatch", init)` reaches the
 * spawned sandbox daemon (the desktop provider tunnels it over the WS+NATS
 * link path; the cluster provider over HTTP) and returns a streaming
 * `Response`. The daemon reverse-proxies the sandbox's SSE response, so the
 * Response body is a stream of SSE event blocks; we reassemble them and decode
 * each event's JSON via `dispatchSSEEventSchema`.
 */
import type { UIMessageChunk } from "ai";
import {
  type MessagesRef,
  offloadKey,
  shouldOffload,
} from "./offload-messages";
import type { HarnessId, HarnessStreamInput } from "./types";
import { parseDispatchSSEStream } from "./parse-dispatch-sse";

export interface RemoteDispatchDeps {
  proxyDaemonRequest: (
    handle: string,
    path: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ) => Promise<Response>;
  /**
   * Body-offload seam. When the encoded dispatch body would exceed the
   * per-message budget (`shouldOffload`), `input.messages` is written to
   * object storage and replaced inline with `[]`; the daemon re-inflates it
   * from `messagesRef`. `supported` mirrors the daemon's advertised
   * `body-offload` capability — when false, an oversized body is a hard error
   * (the daemon couldn't fetch the ref).
   */
  offload?: {
    supported: boolean;
    put: (reqId: string, messagesJson: string) => Promise<MessagesRef>;
    cleanup: (key: string) => Promise<void>;
  };
}

export function remoteDispatch(
  id: HarnessId,
  input: HarnessStreamInput,
  sandboxHandle: string,
  deps: RemoteDispatchDeps,
): AsyncIterable<UIMessageChunk> {
  const { signal, processLocal: _processLocal, ...wireInput } = input;
  return {
    async *[Symbol.asyncIterator]() {
      // Best-effort delete of the offloaded payload fires ONLY after the
      // stream drains cleanly. On abort/throw we leave the object in place —
      // the daemon may still be fetching it, and the bucket's lifecycle TTL
      // reclaims `link-dispatch/*` regardless.
      let cleanupKey: string | null = null;
      let completed = false;
      try {
        // Build the inline body, then decide whether `messages` must be
        // offloaded out of band. The daemon receives the same envelope shape in
        // both cases — only the presence of `messagesRef` differs.
        const baseBody = JSON.stringify({ harnessId: id, input: wireInput });
        let body = baseBody;
        if (shouldOffload(Buffer.byteLength(baseBody, "utf8"))) {
          if (!deps.offload?.supported) {
            throw new Error(
              "[remoteDispatch] request too large and the remote sandbox cannot receive offloaded payloads (daemon too old or no object storage configured)",
            );
          }
          const reqId = crypto.randomUUID();
          const ref = await deps.offload.put(
            reqId,
            JSON.stringify(wireInput.messages),
          );
          cleanupKey = offloadKey(reqId);
          body = JSON.stringify({
            harnessId: id,
            input: { ...wireInput, messages: [] },
            messagesRef: ref,
          });
        }
        const res = await deps.proxyDaemonRequest(sandboxHandle, "/dispatch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body,
          signal,
        });

        // A non-2xx Response carries no `data:` lines (the daemon returns a
        // JSON error body), so feeding it to the SSE parser would silently
        // yield an empty stream — a failed run that looks successful. Read the
        // JSON error and rethrow BEFORE any SSE parsing.
        if (!res.ok) {
          let detail = `dispatch failed (${res.status})`;
          try {
            const j = await res.json();
            if (j && typeof j === "object" && "error" in j && j.error) {
              detail = String((j as { error: unknown }).error);
            }
          } catch {
            /* */
          }
          throw new Error(`[remoteDispatch] ${detail}`);
        }

        const responseBody = res.body;
        if (!responseBody)
          throw new Error("[remoteDispatch] response body is null");
        for await (const chunk of parseDispatchSSEStream(responseBody)) {
          yield chunk;
        }
        completed = true;
      } finally {
        // Eager delete only on clean completion. On any failure the object is left for the bucket-lifecycle TTL — we must not delete while the daemon may still be fetching the ref.
        if (completed && cleanupKey && deps.offload) {
          void deps.offload.cleanup(cleanupKey).catch(() => {});
        }
      }
    },
  };
}
