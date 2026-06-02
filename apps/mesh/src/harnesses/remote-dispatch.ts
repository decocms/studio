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
import { dispatchSSEEventSchema } from "../links/protocol";
import type { HarnessId, HarnessStreamInput } from "./types";

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
      const body = JSON.stringify({ harnessId: id, input: wireInput });

      const emitEvent = function* (
        eventText: string,
      ): Generator<UIMessageChunk> {
        // One SSE event block. Pull `data: ...` lines, join with \n, parse JSON.
        const dataLines = eventText
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice("data: ".length));
        if (dataLines.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLines.join("\n"));
        } catch {
          return;
        }
        const ev = dispatchSSEEventSchema.safeParse(parsed);
        if (!ev.success) return;
        if (ev.data.type === "ui-message-chunk") {
          yield ev.data.chunk as UIMessageChunk;
        } else if (ev.data.type === "error") {
          throw new Error(
            `[remoteDispatch] ${ev.data.code}: ${ev.data.message}`,
          );
        }
        // `done` returns no chunk — outer loop ends when the stream closes.
      };

      const res = await deps.proxyDaemonRequest(sandboxHandle, "/dispatch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body,
        signal,
      });

      // A non-2xx Response carries no `data:` lines (the daemon returns a JSON
      // error body), so feeding it to the SSE parser would silently yield an
      // empty stream — a failed run that looks successful. Read the JSON error
      // and rethrow BEFORE any SSE parsing.
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
      const reader = responseBody.getReader();
      // SINGLE streaming decoder across the whole Response body — a multi-byte
      // UTF-8 char can be split across chunks; a per-chunk decoder corrupts it.
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const chunk of emitEvent(block)) yield chunk;
          sep = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail.length > 0) {
        for (const chunk of emitEvent(tail)) yield chunk;
      }
    },
  };
}
