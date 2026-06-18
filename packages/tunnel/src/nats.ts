import type { Msg, NatsConnection, Subscription } from "nats";

import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  type RequestBodyFrame,
  type RequestStartFrame,
  type ResponseFrame,
  type TunnelDiagnosticEvent,
  type TunnelFrame,
} from "./protocol";
import { base64UrlDecode, base64UrlEncode } from "./stream";
import { buildTunnelSubjects, parseTunnelUrl } from "./subject";

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 30_000;
const DEFAULT_REPUBLISH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const TUNNEL_LOCAL_ORIGIN = "http://tunnel.local";

export type TunnelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateFetchOptions {
  readonly connection: NatsConnection;
  readonly timeoutMs?: number;
  readonly firstFrameTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly republishIntervalMs?: number;
  readonly maxChunkBytes?: number;
  readonly diagnostics?: (event: TunnelDiagnosticEvent) => void;
}

export interface ServeOptions {
  readonly connection: NatsConnection;
  readonly hostname: string;
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly signal?: AbortSignal;
  readonly maxChunkBytes?: number;
  readonly diagnostics?: (event: TunnelDiagnosticEvent) => void;
}

export interface TunnelServer {
  readonly hostname: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

class TunnelTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "TunnelTransportError";
  }
}

const isCreateFetchOptions = (
  input: NatsConnection | CreateFetchOptions,
): input is CreateFetchOptions => {
  return "connection" in input;
};

const normalizeCreateFetchOptions = (
  input: NatsConnection | CreateFetchOptions,
): Required<Omit<CreateFetchOptions, "diagnostics">> &
  Pick<CreateFetchOptions, "diagnostics"> => {
  const options = isCreateFetchOptions(input) ? input : { connection: input };

  return {
    connection: options.connection,
    timeoutMs: options.timeoutMs ?? 0,
    firstFrameTimeoutMs:
      options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    republishIntervalMs:
      options.republishIntervalMs ?? DEFAULT_REPUBLISH_INTERVAL_MS,
    maxChunkBytes: options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
    diagnostics: options.diagnostics,
  };
};

const headersToEntries = (headers: Headers): Array<[string, string]> => {
  return Array.from(headers.entries());
};

const isIterableHeaderTuples = (headers: HeadersInit | undefined): boolean => {
  return (
    headers !== undefined &&
    !(headers instanceof Headers) &&
    typeof headers !== "function" &&
    typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function"
  );
};

const requestHeaderEntries = (
  input: string | URL | Request,
  init: RequestInit | undefined,
  request: Request,
): Array<[string, string]> => {
  if (isIterableHeaderTuples(init?.headers)) {
    return Array.from(
      init?.headers as Iterable<[string, string]>,
      ([name, value]) => [String(name), String(value)],
    );
  }

  if (input instanceof Request) {
    return headersToEntries(request.headers);
  }

  return headersToEntries(request.headers);
};

const entriesToHeaders = (entries: Array<[string, string]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of entries) {
    headers.append(name, value);
  }
  return headers;
};

const randomRequestId = (): string => {
  return crypto.randomUUID().replaceAll("-", "");
};

const unsubscribeQuietly = (subscription: Subscription | undefined): void => {
  try {
    subscription?.unsubscribe();
  } catch {
    // Subscription may already be closed by the connection.
  }
};

function* splitBytes(
  bytes: Uint8Array,
  maxChunkBytes: number,
): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
    yield bytes.subarray(offset, offset + maxChunkBytes);
  }
}

const validateMaxChunkBytes = (maxChunkBytes: number): void => {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
    throw new TypeError("maxChunkBytes must be a positive safe integer");
  }
};

const responseMustNotHaveBody = (method: string, status: number): boolean => {
  return (
    method === "HEAD" || status === 204 || status === 205 || status === 304
  );
};

const publishFrame = (
  connection: NatsConnection,
  subject: string,
  frame: TunnelFrame,
): void => {
  connection.publish(subject, encodeTunnelFrame(frame));
};

const isResponseFrame = (frame: TunnelFrame): frame is ResponseFrame => {
  return frame.type.startsWith("response.");
};

const isRequestBodyFrame = (frame: TunnelFrame): frame is RequestBodyFrame => {
  return frame.type.startsWith("request.") && frame.type !== "request.start";
};

const signalReason = (signal: AbortSignal): string => {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "aborted";
};

const timeoutError = (kind: "first_frame" | "idle"): TunnelTransportError => {
  if (kind === "idle") {
    return new TunnelTransportError(
      "tunnel_idle_timeout",
      "no response frame within idleTimeoutMs",
    );
  }
  return new TunnelTransportError(
    "tunnel_no_first_frame",
    "no response frame arrived before firstFrameTimeoutMs",
  );
};

const readNextReply = async (
  iterator: AsyncIterator<Msg>,
  requestId: string,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutKind: "first_frame" | "idle" = "first_frame",
): Promise<IteratorResult<ResponseFrame>> => {
  while (true) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<Msg>>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          const abort = () => reject(signal.reason);
          removeAbortListener = () => {
            signal.removeEventListener("abort", abort);
          };
          signal.addEventListener("abort", abort, { once: true });
        }),
        ...(timeoutMs > 0
          ? [
              new Promise<IteratorResult<Msg>>((_, reject) => {
                timeoutId = setTimeout(() => {
                  reject(timeoutError(timeoutKind));
                }, timeoutMs);
              }),
            ]
          : []),
      ]);

      if (result.done) {
        return { value: undefined, done: true };
      }

      const frame = decodeTunnelFrame(result.value.data);
      if (!isResponseFrame(frame) || frame.requestId !== requestId) {
        continue;
      }
      return { value: frame, done: false };
    } finally {
      removeAbortListener?.();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
};

const waitForResponseStart = async (options: {
  readonly iterator: AsyncIterator<Msg>;
  readonly requestId: string;
  readonly firstFrameTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly onFirstResponseFrame: () => void;
}): Promise<ResponseFrame & { type: "response.start" }> => {
  let sawResponseFrame = false;

  while (true) {
    const result = await readNextReply(
      options.iterator,
      options.requestId,
      sawResponseFrame ? 0 : options.firstFrameTimeoutMs,
      options.signal,
    );

    if (result.done) {
      throw new TunnelTransportError(
        "tunnel_response_closed",
        "response subscription closed before response.start",
      );
    }

    if (!sawResponseFrame) {
      sawResponseFrame = true;
      options.onFirstResponseFrame();
    }

    if (result.value.type === "response.ack") {
      continue;
    }
    if (result.value.type === "response.start") {
      return result.value;
    }
    if (result.value.type === "response.error") {
      throw new TunnelTransportError(result.value.code, result.value.message);
    }

    throw new TunnelTransportError(
      "tunnel_unexpected_response_frame",
      `expected response.start, got ${result.value.type}`,
    );
  }
};

const pumpReadableBody = async (options: {
  readonly connection: NatsConnection;
  readonly subject: string;
  readonly requestId: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly maxChunkBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> => {
  const reader = options.body.getReader();
  let seq = 0;
  let canceled = false;

  const cancel = () => {
    canceled = true;
    reader.cancel(options.signal.reason).catch(() => {});
  };

  try {
    if (options.signal.aborted) {
      cancel();
      return;
    }
    options.signal.addEventListener("abort", cancel, { once: true });

    while (true) {
      const { done, value } = await reader.read();
      if (canceled) {
        return;
      }
      if (done) {
        publishFrame(options.connection, options.subject, {
          type: "request.end",
          requestId: options.requestId,
          seq,
        });
        return;
      }
      for (const chunk of splitBytes(value, options.maxChunkBytes)) {
        if (canceled) {
          return;
        }
        publishFrame(options.connection, options.subject, {
          type: "request.chunk",
          requestId: options.requestId,
          seq,
          data: base64UrlEncode(chunk),
        });
        seq++;
      }
    }
  } catch (error) {
    if (canceled) {
      return;
    }
    publishFrame(options.connection, options.subject, {
      type: "request.error",
      requestId: options.requestId,
      code: "tunnel_request_body_error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    options.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};

const responseBodyFromReply = (options: {
  readonly connection: NatsConnection;
  readonly abortSubject: string;
  readonly iterator: AsyncIterator<Msg>;
  readonly requestId: string;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (true) {
          try {
            const result = await readNextReply(
              options.iterator,
              options.requestId,
              options.idleTimeoutMs,
              options.signal,
              "idle",
            );
            if (result.done) {
              controller.error(
                new TunnelTransportError(
                  "tunnel_response_closed",
                  "response subscription closed before response.end",
                ),
              );
              options.cleanup();
              return;
            }

            const frame = result.value;
            if (
              frame.type === "response.ack" ||
              frame.type === "response.start"
            ) {
              continue;
            }
            if (frame.type === "response.chunk") {
              controller.enqueue(base64UrlDecode(frame.data));
              return;
            }
            if (frame.type === "response.end") {
              controller.close();
              options.cleanup();
              return;
            }
            controller.error(
              new TunnelTransportError(frame.code, frame.message),
            );
            options.cleanup();
            return;
          } catch (error) {
            controller.error(error);
            options.cleanup();
            return;
          }
        }
      },
      cancel() {
        publishFrame(options.connection, options.abortSubject, {
          type: "abort",
          requestId: options.requestId,
          reason: "response_body_cancelled",
        });
        options.cleanup();
      },
    },
    {
      highWaterMark: 0,
    },
  );
};

export const createFetch = (
  inputOptions: NatsConnection | CreateFetchOptions,
): TunnelFetch => {
  const options = normalizeCreateFetchOptions(inputOptions);
  validateMaxChunkBytes(options.maxChunkBytes);

  return async (input, init) => {
    const parsed = parseTunnelUrl(input);
    const request = new Request(input, init);
    const requestId = randomRequestId();
    const subjects = buildTunnelSubjects(parsed.hostname, requestId);
    const operationAbort = new AbortController();
    const bodyPumpAbort = new AbortController();
    let cleanedUp = false;
    let replySub: Subscription | undefined;
    let replyIterator: AsyncIterator<Msg> | undefined;
    let republishInterval: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let bodyPumpStarted = false;

    const cleanup = (
      reason: Error = new TunnelTransportError(
        "tunnel_closed",
        "tunnel request closed",
      ),
    ) => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      unsubscribeQuietly(replySub);
      if (request.body && !bodyPumpStarted) {
        request.body.cancel(reason).catch(() => {});
      }
      bodyPumpAbort.abort(reason);
      operationAbort.abort(reason);
      if (republishInterval) {
        clearInterval(republishInterval);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      request.signal.removeEventListener("abort", abortRequest);
    };

    const abortRequest = () => {
      const error = new TunnelTransportError(
        "tunnel_aborted",
        signalReason(request.signal),
      );
      publishFrame(options.connection, subjects.abort, {
        type: "abort",
        requestId,
        reason: signalReason(request.signal),
      });
      operationAbort.abort(error);
      cleanup(error);
    };

    if (request.signal.aborted) {
      throw new TunnelTransportError(
        "tunnel_aborted",
        signalReason(request.signal),
      );
    }

    replySub = options.connection.subscribe(subjects.reply);
    replyIterator = replySub[Symbol.asyncIterator]();

    request.signal.addEventListener("abort", abortRequest, { once: true });

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        const error = new TunnelTransportError(
          "tunnel_timeout",
          `tunnel request timed out after ${options.timeoutMs}ms`,
        );
        publishFrame(options.connection, subjects.abort, {
          type: "abort",
          requestId,
          reason: "tunnel_timeout",
        });
        operationAbort.abort(error);
        cleanup(error);
      }, options.timeoutMs);
    }

    const requestStartFrame = {
      type: "request.start",
      protocol: "tunnel.v1",
      requestId,
      method: request.method,
      url: parsed.pathWithSearch,
      headers: requestHeaderEntries(input, init, request),
      replySubject: subjects.reply,
      abortSubject: subjects.abort,
      ...(request.body ? { bodySubject: subjects.body } : {}),
      ...(options.timeoutMs > 0
        ? { deadlineUnixMs: Date.now() + options.timeoutMs }
        : {}),
    } satisfies RequestStartFrame;

    publishFrame(options.connection, subjects.request, requestStartFrame);

    republishInterval =
      options.republishIntervalMs > 0
        ? setInterval(() => {
            if (!bodyPumpStarted) {
              publishFrame(
                options.connection,
                subjects.request,
                requestStartFrame,
              );
            }
          }, options.republishIntervalMs)
        : undefined;

    const startBodyPump = () => {
      if (bodyPumpStarted) {
        return;
      }
      bodyPumpStarted = true;

      const bodyPump = request.body
        ? pumpReadableBody({
            connection: options.connection,
            subject: subjects.body,
            requestId,
            body: request.body,
            maxChunkBytes: options.maxChunkBytes,
            signal: bodyPumpAbort.signal,
          })
        : undefined;
      bodyPump?.catch((error) => {
        options.diagnostics?.({
          event: "request_body_error",
          requestId,
          subject: subjects.body,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    try {
      const responseStart = await waitForResponseStart({
        iterator: replyIterator,
        requestId,
        firstFrameTimeoutMs: options.firstFrameTimeoutMs,
        signal: operationAbort.signal,
        onFirstResponseFrame: () => {
          if (republishInterval) {
            clearInterval(republishInterval);
          }
          startBodyPump();
        },
      });

      if (responseMustNotHaveBody(request.method, responseStart.status)) {
        cleanup();
        return new Response(null, {
          status: responseStart.status,
          statusText: responseStart.statusText,
          headers: entriesToHeaders(responseStart.headers),
        });
      }

      return new Response(
        responseBodyFromReply({
          connection: options.connection,
          abortSubject: subjects.abort,
          iterator: replyIterator,
          requestId,
          idleTimeoutMs: options.idleTimeoutMs,
          signal: operationAbort.signal,
          cleanup,
        }),
        {
          status: responseStart.status,
          statusText: responseStart.statusText,
          headers: entriesToHeaders(responseStart.headers),
        },
      );
    } catch (error) {
      cleanup(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
};

const requestBodyFromSubject = (options: {
  readonly connection: NatsConnection;
  readonly subject: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly diagnostics?: (event: TunnelDiagnosticEvent) => void;
}): {
  readonly body: ReadableStream<Uint8Array>;
  readonly close: () => void;
} => {
  const sub = options.connection.subscribe(options.subject);
  const iterator = sub[Symbol.asyncIterator]();

  return {
    body: new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (options.signal.aborted) {
            controller.error(options.signal.reason);
            unsubscribeQuietly(sub);
            return;
          }

          try {
            while (true) {
              let removeAbortListener: (() => void) | undefined;
              const result = await Promise.race([
                iterator.next(),
                new Promise<IteratorResult<Msg>>((_, reject) => {
                  const abort = () => reject(options.signal.reason);
                  removeAbortListener = () => {
                    options.signal.removeEventListener("abort", abort);
                  };
                  options.signal.addEventListener("abort", abort, {
                    once: true,
                  });
                }),
              ]).finally(() => {
                removeAbortListener?.();
              });
              if (result.done) {
                controller.error(
                  new TunnelTransportError(
                    "tunnel_request_body_closed",
                    "request body subscription closed before request.end",
                  ),
                );
                unsubscribeQuietly(sub);
                return;
              }

              const frame = decodeTunnelFrame(result.value.data);
              if (
                isRequestBodyFrame(frame) &&
                frame.requestId === options.requestId
              ) {
                if (frame.type === "request.chunk") {
                  controller.enqueue(base64UrlDecode(frame.data));
                  return;
                }
                if (frame.type === "request.end") {
                  controller.close();
                  unsubscribeQuietly(sub);
                  return;
                }
                controller.error(
                  new TunnelTransportError(frame.code, frame.message),
                );
                unsubscribeQuietly(sub);
                return;
              }
            }
          } catch (error) {
            options.diagnostics?.({
              event: "request_body_decode_error",
              requestId: options.requestId,
              subject: options.subject,
              error: error instanceof Error ? error.message : String(error),
            });
            controller.error(error);
            unsubscribeQuietly(sub);
          }
        },
        cancel() {
          unsubscribeQuietly(sub);
        },
      },
      {
        highWaterMark: 0,
      },
    ),
    close() {
      unsubscribeQuietly(sub);
    },
  };
};

const pumpResponseBody = async (options: {
  readonly connection: NatsConnection;
  readonly subject: string;
  readonly requestId: string;
  readonly response: Response;
  readonly maxChunkBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> => {
  const body = options.response.body;
  let seq = 0;

  if (!body) {
    publishFrame(options.connection, options.subject, {
      type: "response.end",
      requestId: options.requestId,
      seq,
    });
    return;
  }

  const reader = body.getReader();
  let canceled = false;
  const cancel = () => {
    canceled = true;
    reader.cancel(options.signal.reason).catch(() => {});
  };

  try {
    if (options.signal.aborted) {
      cancel();
      return;
    }
    options.signal.addEventListener("abort", cancel, { once: true });

    while (true) {
      const { done, value } = await reader.read();
      if (canceled) {
        return;
      }
      if (done) {
        publishFrame(options.connection, options.subject, {
          type: "response.end",
          requestId: options.requestId,
          seq,
        });
        return;
      }
      for (const chunk of splitBytes(value, options.maxChunkBytes)) {
        if (canceled) {
          return;
        }
        publishFrame(options.connection, options.subject, {
          type: "response.chunk",
          requestId: options.requestId,
          seq,
          data: base64UrlEncode(chunk),
        });
        seq++;
      }
    }
  } catch (error) {
    if (canceled) {
      return;
    }
    publishFrame(options.connection, options.subject, {
      type: "response.error",
      requestId: options.requestId,
      code: "tunnel_response_body_error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    options.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};

const queueGroupForHostname = (hostname: string): string => {
  return `tunnel_v1_host_${buildTunnelSubjects(hostname, "server").hostToken}`;
};

const abortWildcardSubject = (hostname: string): string => {
  const subjects = buildTunnelSubjects(hostname, "server");
  return `tunnel.v1.host.${subjects.hostToken}.req.*.abort`;
};

const REQUEST_TRACKING_TTL_MS = 60_000;
const MAX_TRACKED_REQUESTS = 10_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const requestIdFromAbortSubject = (
  hostname: string,
  subject: string,
): string | undefined => {
  const subjects = buildTunnelSubjects(hostname, "server");
  const prefix = `tunnel.v1.host.${subjects.hostToken}.req.`;
  const suffix = ".abort";

  if (!subject.startsWith(prefix) || !subject.endsWith(suffix)) {
    return undefined;
  }

  const requestId = subject.slice(prefix.length, -suffix.length);
  return REQUEST_ID_PATTERN.test(requestId) ? requestId : undefined;
};

class BoundedTtlCache<T> {
  #entries = new Map<
    string,
    { readonly value: T; readonly expiresAt: number }
  >();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: T): void {
    const now = this.now();
    this.prune(now);
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + this.ttlMs });

    while (this.#entries.size > this.maxSize) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.#entries.delete(oldest);
    }
  }

  take(key: string): T | undefined {
    const value = this.get(key);
    this.#entries.delete(key);
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }
}

interface AbortRegistry {
  readonly controllers: Map<string, AbortController>;
  readonly pending: BoundedTtlCache<string>;
}

interface RequestRegistry {
  readonly active: Set<string>;
  readonly seen: BoundedTtlCache<true>;
}

const handleRequest = async (
  options: ServeOptions & {
    readonly maxChunkBytes: number;
    readonly abortRegistry: AbortRegistry;
  },
  frame: RequestStartFrame,
): Promise<void> => {
  const abortController = new AbortController();
  options.abortRegistry.controllers.set(frame.requestId, abortController);
  const pendingAbortReason = options.abortRegistry.pending.take(
    frame.requestId,
  );
  if (pendingAbortReason !== undefined) {
    abortController.abort(pendingAbortReason);
  }

  const requestBody = frame.bodySubject
    ? requestBodyFromSubject({
        connection: options.connection,
        subject: frame.bodySubject,
        requestId: frame.requestId,
        signal: abortController.signal,
        diagnostics: options.diagnostics,
      })
    : undefined;

  publishFrame(options.connection, frame.replySubject, {
    type: "response.ack",
    requestId: frame.requestId,
  });

  try {
    const request = new Request(`${TUNNEL_LOCAL_ORIGIN}${frame.url}`, {
      method: frame.method,
      headers: entriesToHeaders(frame.headers),
      body: requestBody?.body,
      signal: abortController.signal,
      ...(requestBody ? { duplex: "half" } : {}),
    } as RequestInit);

    const response = await options.fetch(request);

    publishFrame(options.connection, frame.replySubject, {
      type: "response.start",
      requestId: frame.requestId,
      status: response.status,
      statusText: response.statusText,
      headers: headersToEntries(response.headers),
    });

    if (responseMustNotHaveBody(frame.method, response.status)) {
      await response.body?.cancel().catch(() => {});
      publishFrame(options.connection, frame.replySubject, {
        type: "response.end",
        requestId: frame.requestId,
        seq: 0,
      });
      return;
    }

    await pumpResponseBody({
      connection: options.connection,
      subject: frame.replySubject,
      requestId: frame.requestId,
      response,
      maxChunkBytes: options.maxChunkBytes,
      signal: abortController.signal,
    });
  } catch (error) {
    publishFrame(options.connection, frame.replySubject, {
      type: "response.error",
      requestId: frame.requestId,
      code: "tunnel_handler_error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    requestBody?.close();
    options.abortRegistry.controllers.delete(frame.requestId);
  }
};

export const serve = async (options: ServeOptions): Promise<TunnelServer> => {
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  validateMaxChunkBytes(maxChunkBytes);

  const subjects = buildTunnelSubjects(options.hostname, "server");
  const requestSub = options.connection.subscribe(subjects.request, {
    queue: queueGroupForHostname(options.hostname),
  });
  const abortSub = options.connection.subscribe(
    abortWildcardSubject(options.hostname),
  );
  const inFlight = new Set<Promise<void>>();
  const abortRegistry: AbortRegistry = {
    controllers: new Map(),
    pending: new BoundedTtlCache<string>(
      MAX_TRACKED_REQUESTS,
      REQUEST_TRACKING_TTL_MS,
    ),
  };
  const requestRegistry: RequestRegistry = {
    active: new Set(),
    seen: new BoundedTtlCache<true>(
      MAX_TRACKED_REQUESTS,
      REQUEST_TRACKING_TTL_MS,
    ),
  };

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const close = async (): Promise<void> => {
    unsubscribeQuietly(requestSub);
    unsubscribeQuietly(abortSub);
    for (const controller of abortRegistry.controllers.values()) {
      controller.abort("tunnel_server_closed");
    }
    await closed;
  };

  const abortClose = () => {
    close().catch(() => {});
  };
  options.signal?.addEventListener("abort", abortClose, { once: true });

  const abortLoop = (async () => {
    try {
      for await (const msg of abortSub) {
        let frame: TunnelFrame;
        try {
          frame = decodeTunnelFrame(msg.data);
        } catch (error) {
          options.diagnostics?.({
            event: "abort_decode_error",
            subject: msg.subject,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (frame.type !== "abort") {
          continue;
        }
        const subjectRequestId = requestIdFromAbortSubject(
          options.hostname,
          msg.subject,
        );
        if (subjectRequestId !== frame.requestId) {
          options.diagnostics?.({
            event: "abort_request_id_mismatch",
            requestId: frame.requestId,
            subject: msg.subject,
          });
          continue;
        }

        const reason = frame.reason ?? "aborted";
        const controller = abortRegistry.controllers.get(frame.requestId);
        if (controller) {
          controller.abort(reason);
          continue;
        }

        abortRegistry.pending.set(frame.requestId, reason);
      }
    } catch (error) {
      options.diagnostics?.({
        event: "abort_subscription_error",
        subject: abortWildcardSubject(options.hostname),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  abortLoop.catch(() => {});

  const loop = (async () => {
    try {
      for await (const msg of requestSub) {
        let frame: TunnelFrame;
        try {
          frame = decodeTunnelFrame(msg.data);
        } catch (error) {
          options.diagnostics?.({
            event: "request_decode_error",
            subject: msg.subject,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (frame.type !== "request.start") {
          continue;
        }

        if (
          requestRegistry.active.has(frame.requestId) ||
          requestRegistry.seen.has(frame.requestId)
        ) {
          publishFrame(options.connection, frame.replySubject, {
            type: "response.ack",
            requestId: frame.requestId,
          });
          continue;
        }

        requestRegistry.active.add(frame.requestId);
        const task = handleRequest(
          { ...options, maxChunkBytes, abortRegistry },
          frame,
        ).finally(() => {
          inFlight.delete(task);
          requestRegistry.active.delete(frame.requestId);
          requestRegistry.seen.set(frame.requestId, true);
        });
        inFlight.add(task);
      }
    } finally {
      options.signal?.removeEventListener("abort", abortClose);
      unsubscribeQuietly(abortSub);
      abortRegistry.pending.clear();
      requestRegistry.seen.clear();
      requestRegistry.active.clear();
      await Promise.allSettled(inFlight);
      resolveClosed();
    }
  })();
  loop.catch((error) => {
    options.diagnostics?.({
      event: "request_subscription_error",
      subject: subjects.request,
      error: error instanceof Error ? error.message : String(error),
    });
    resolveClosed();
  });

  return {
    hostname: options.hostname,
    closed,
    close,
  };
};
