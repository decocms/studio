import type { RequestFrame } from "../links/link-control-types";
import type { ControlHandler, StreamEvent } from "./control-handler";

function isLifecyclePath(pathname: string): boolean {
  return (
    pathname === "/api/sandboxes" ||
    pathname.startsWith("/api/sandboxes/") ||
    pathname === "/api/links/work" ||
    pathname === "/api/links/control"
  );
}

async function requestFrameFromRequest(
  request: Request,
): Promise<RequestFrame> {
  const url = new URL(request.url);
  const frame: RequestFrame = {
    type: "request",
    reqId: crypto.randomUUID(),
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  };
  if (request.body !== null) {
    frame.body = await request.text();
  }
  return frame;
}

function isHeadersEvent(
  event: IteratorResult<StreamEvent>,
): event is IteratorYieldResult<Extract<StreamEvent, { type: "headers" }>> {
  return !event.done && event.value.type === "headers";
}

export function createControlHandlerFetch(
  controlHandler: ControlHandler,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const frame = await requestFrameFromRequest(request);
    const url = new URL(request.url);

    if (isLifecyclePath(url.pathname)) {
      const res = await controlHandler.handle(frame);
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    }

    const responseAbort = new AbortController();
    const streamSignal = AbortSignal.any([
      request.signal,
      responseAbort.signal,
    ]);
    const iterator = controlHandler
      .handleStream(frame, streamSignal)
      [Symbol.asyncIterator]();
    const cleanup = async (): Promise<void> => {
      responseAbort.abort();
      try {
        await iterator.return?.();
      } catch {
        // Best-effort cleanup: cancellation must not mask the stream outcome.
      }
    };
    const first = await iterator.next();
    if (!isHeadersEvent(first)) {
      await cleanup();
      return new Response("bad gateway", { status: 502 });
    }

    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await iterator.next();
            if (done) {
              controller.close();
              return;
            }
            if (value.type === "raw-chunk") {
              controller.enqueue(value.data);
            }
          } catch (err) {
            await cleanup();
            controller.error(err);
          }
        },
        async cancel() {
          await cleanup();
        },
      }),
      {
        status: first.value.status,
        headers: first.value.headers,
      },
    );
  };
}
