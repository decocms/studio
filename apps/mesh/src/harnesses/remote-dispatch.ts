/**
 * Remote dispatch — cluster → daemon over the WS+NATS link path.
 *
 * The daemon's control handler reverse-proxies `/_sandbox/<handle>/dispatch`
 * to the spawned sandbox daemon, which emits an SSE response. The bytes
 * arrive at us as raw chunk-frame payloads; we reassemble SSE events and
 * decode each event's JSON via `dispatchSSEEventSchema`.
 */
import type { UIMessageChunk } from "ai";
import { dispatchSSEEventSchema } from "../links/protocol";
import type { DispatchFn } from "../links/dispatcher";
import type { HarnessId, HarnessStreamInput } from "./types";

export interface RemoteDispatchDeps {
  dispatch: DispatchFn;
}

export function remoteDispatch(
  id: HarnessId,
  input: HarnessStreamInput,
  userSub: string,
  sandboxHandle: string,
  deps: RemoteDispatchDeps,
): AsyncIterable<UIMessageChunk> {
  const { signal, processLocal: _processLocal, ...wireInput } = input;
  return {
    async *[Symbol.asyncIterator]() {
      const body = JSON.stringify({ harnessId: id, input: wireInput });
      const iter = deps.dispatch(
        userSub,
        {
          method: "POST",
          path: `/_sandbox/${sandboxHandle}/dispatch`,
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body,
        },
        { signal },
      );

      let buffer = "";
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
        // `done` returns no chunk — outer loop ends when the iterable closes.
      };

      for await (const raw of iter) {
        buffer += raw.data;
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const chunk of emitEvent(eventBlock)) yield chunk;
          sep = buffer.indexOf("\n\n");
        }
      }
      const tail = buffer.trim();
      if (tail.length > 0) {
        for (const chunk of emitEvent(tail)) yield chunk;
      }
    },
  };
}
