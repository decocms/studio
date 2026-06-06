/**
 * dispatchToDaemon: cluster → daemon over NATS.
 *
 * Encodes a `request` frame, publishes it on `links.dispatch.<userSub>` with
 * a per-call reply inbox, and yields `ChunkFrame.data` strings as they arrive
 * on the inbox. Terminates on `end` (clean) or `error` (throws). On caller
 * abort, publishes a `cancel` on `links.cancel.<userSub>` so the owner pod
 * can forward it to the daemon.
 */
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";

// Transport-neutral dispatch types live in their own module (S0) so the
// surviving consumers and the pull reverse-proxy adapter don't depend on this
// WS-specific file. Re-export them here so existing `./dispatcher` importers
// keep working unchanged. `DispatchFn` is also imported locally below for the
// `createDispatcher` return-type annotation (a bare re-export does not bring a
// name into local scope).
import type { DispatchFn } from "./link-dispatch-types";
export type {
  DispatchChunk,
  DispatchFn,
  DispatchHeaders,
  DispatchOptions,
  DispatchRequest,
} from "./link-dispatch-types";

export interface DispatcherNatsAdapter {
  publish(subject: string, data: Uint8Array, opts?: { reply?: string }): void;
  subscribe(
    subject: string,
    onMessage: (data: Uint8Array, reply?: string) => void,
  ): () => void;
  createInbox(): string;
}

export interface CreateDispatcherDeps {
  nats: DispatcherNatsAdapter;
  /** First-reply timeout. Default 30_000. */
  requestTimeoutMs?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createDispatcher(deps: CreateDispatcherDeps): DispatchFn {
  const timeoutMs = deps.requestTimeoutMs ?? 30_000;

  return function dispatch(userSub, req, opts) {
    return {
      async *[Symbol.asyncIterator]() {
        // Fast-path: if the caller's signal is already aborted at entry,
        // the `addEventListener("abort", ...)` below would never fire (the
        // abort event has already been dispatched). Without this check the
        // request would be published and the consumer would wait the full
        // requestTimeoutMs for a reply that's never coming.
        if (opts?.signal?.aborted) {
          throw new Error("dispatch aborted");
        }
        const reqId = crypto.randomUUID();
        const inbox = deps.nats.createInbox();
        const queue: DispatchFrame[] = [];
        let resolve: (() => void) | null = null;
        let done = false;
        let error: Error | null = null;
        let firstReplyTimer: ReturnType<typeof setTimeout> | null = null;

        const wake = (): void => {
          if (firstReplyTimer) {
            clearTimeout(firstReplyTimer);
            firstReplyTimer = null;
          }
          const r = resolve;
          resolve = null;
          r?.();
        };

        const unsubscribe = deps.nats.subscribe(inbox, (data) => {
          if (done) return;
          try {
            queue.push(decodeFrame(decoder.decode(data)));
          } catch (err) {
            error = err instanceof Error ? err : new Error(String(err));
            done = true;
          }
          wake();
        });

        let cleanedUp = false;
        const cleanup = (): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          done = true;
          try {
            unsubscribe();
          } catch {
            /* */
          }
        };

        const onAbort = (): void => {
          deps.nats.publish(
            `links.cancel.${userSub}`,
            encoder.encode(encodeFrame({ type: "cancel", reqId })),
          );
          error = new Error("dispatch aborted");
          cleanup();
          wake();
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        try {
          deps.nats.publish(
            `links.dispatch.${userSub}`,
            encoder.encode(
              encodeFrame({
                type: "request",
                reqId,
                method: req.method,
                path: req.path,
                headers: req.headers,
                ...(req.body !== undefined ? { body: req.body } : {}),
              }),
            ),
            { reply: inbox },
          );
        } catch (err) {
          // e.g. a request body over max_payload (follow-up F1 will chunk
          // these). This path skips the finally below, so detach the abort
          // listener and tear down the inbox subscription before surfacing.
          opts?.signal?.removeEventListener("abort", onAbort);
          cleanup();
          throw err instanceof Error ? err : new Error(String(err));
        }

        const firstReplyDeadline = Date.now() + timeoutMs;
        let receivedAny = false;

        try {
          while (!done) {
            if (error) throw error;
            if (queue.length === 0) {
              const remaining = firstReplyDeadline - Date.now();
              if (!receivedAny && remaining <= 0) {
                throw new Error("dispatch timeout: no reply from daemon");
              }
              await new Promise<void>((res) => {
                resolve = res;
                if (!receivedAny) {
                  firstReplyTimer = setTimeout(wake, Math.max(0, remaining));
                }
              });
              if (error) throw error;
              continue;
            }
            const frame = queue.shift()!;
            receivedAny = true;
            if (frame.type === "chunk") {
              yield { data: frame.data };
            } else if (frame.type === "headers") {
              yield {
                headers: { status: frame.status, headers: frame.headers },
              };
            } else if (frame.type === "end") {
              return;
            } else if (frame.type === "error") {
              throw new Error(`${frame.code}: ${frame.message}`);
            }
          }
          if (error) throw error;
        } finally {
          opts?.signal?.removeEventListener("abort", onAbort);
          if (firstReplyTimer) {
            clearTimeout(firstReplyTimer);
            firstReplyTimer = null;
          }
          cleanup();
        }
      },
    };
  };
}
