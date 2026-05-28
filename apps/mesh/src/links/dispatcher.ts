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

export interface DispatcherNatsAdapter {
  publish(subject: string, data: Uint8Array, opts?: { reply?: string }): void;
  subscribe(
    subject: string,
    onMessage: (data: Uint8Array, reply?: string) => void,
  ): () => void;
  createInbox(): string;
}

export interface DispatchRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface DispatchChunk {
  data: string;
}

export interface DispatchOptions {
  signal?: AbortSignal;
}

export interface CreateDispatcherDeps {
  nats: DispatcherNatsAdapter;
  /** First-reply timeout. Default 30_000. */
  requestTimeoutMs?: number;
}

export type DispatchFn = (
  userSub: string,
  req: DispatchRequest,
  opts?: DispatchOptions,
) => AsyncIterable<DispatchChunk>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createDispatcher(deps: CreateDispatcherDeps): DispatchFn {
  const timeoutMs = deps.requestTimeoutMs ?? 30_000;

  return function dispatch(userSub, req, opts) {
    return {
      async *[Symbol.asyncIterator]() {
        const reqId = crypto.randomUUID();
        const inbox = deps.nats.createInbox();
        const queue: DispatchFrame[] = [];
        let resolve: (() => void) | null = null;
        let done = false;
        let error: Error | null = null;

        const wake = (): void => {
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

        const cleanup = (): void => {
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

        const firstReplyDeadline = Date.now() + timeoutMs;
        let receivedAny = false;

        try {
          while (!done) {
            if (queue.length === 0) {
              const remaining = firstReplyDeadline - Date.now();
              if (!receivedAny && remaining <= 0) {
                throw new Error("dispatch timeout: no reply from daemon");
              }
              await new Promise<void>((res) => {
                resolve = res;
                if (!receivedAny) {
                  setTimeout(wake, Math.max(0, remaining));
                }
              });
              if (error) throw error;
              continue;
            }
            const frame = queue.shift()!;
            receivedAny = true;
            if (frame.type === "chunk") {
              yield { data: frame.data };
            } else if (frame.type === "end") {
              return;
            } else if (frame.type === "error") {
              throw new Error(`${frame.code}: ${frame.message}`);
            }
            // headers and other frame types are ignored for v1
          }
          if (error) throw error;
        } finally {
          opts?.signal?.removeEventListener("abort", onAbort);
          cleanup();
        }
      },
    };
  };
}
