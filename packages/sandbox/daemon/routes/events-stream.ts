import type { Broadcaster } from "../events/broadcast";
import { makeSseStream, type SseHandshakeDeps } from "../events/sse";
import { MAX_SSE_CLIENTS } from "../constants";

export function makeEventsHandler(
  deps: Omit<SseHandshakeDeps, "maxClients"> & { broadcaster: Broadcaster },
) {
  return async (): Promise<Response> => {
    const stream = makeSseStream({ ...deps, maxClients: MAX_SSE_CLIENTS });
    if (!stream) {
      return new Response("Too many connections", {
        status: 429,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "identity",
      },
    });
  };
}
