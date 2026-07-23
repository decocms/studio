import {
  createFetch as createTunnelFetch,
  type TunnelFetch,
} from "@decocms/tunnel";
import type { NatsConnection } from "@nats-io/nats-core";
import type { DispatchChunk, DispatchFn } from "./link-dispatch-types";
import { buildUserTunnelHostname } from "./tunnel-host";

export type { TunnelFetch };

export type TunnelFetchFactory = (connection: NatsConnection) => TunnelFetch;

export interface CreateTunnelDispatchDeps {
  getConnection: () => NatsConnection | null;
  createFetch?: TunnelFetchFactory;
}

export async function* responseToDispatchChunks(
  response: Response,
): AsyncIterable<DispatchChunk> {
  if (!response.body) {
    yield {
      headers: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
    };
    return;
  }

  const reader = response.body.getReader();
  let bodyComplete = false;
  try {
    yield {
      headers: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        bodyComplete = true;
        return;
      }
      yield { data: Buffer.from(value).toString("base64") };
    }
  } finally {
    try {
      if (!bodyComplete) {
        await reader.cancel();
      }
    } catch {
      // Preserve any original read/consumer error.
    } finally {
      reader.releaseLock();
    }
  }
}

const DISPATCH_IDLE_TIMEOUT_MS = 45_000;

export function createTunnelDispatch(
  deps: CreateTunnelDispatchDeps,
): DispatchFn {
  const makeFetch =
    deps.createFetch ??
    ((connection) =>
      createTunnelFetch({
        connection,
        idleTimeoutMs: DISPATCH_IDLE_TIMEOUT_MS,
      }));

  return async function* tunnelDispatch(userSub, req, opts) {
    const connection = deps.getConnection();
    if (!connection) {
      throw new Error("link_unavailable: NATS unavailable");
    }

    const hostname = buildUserTunnelHostname(userSub);
    const tunnelFetch = makeFetch(connection);
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      signal: opts?.signal,
    };
    if (req.body != null) {
      init.body = req.body;
    }

    const response = await tunnelFetch(`tunnel://${hostname}${req.path}`, init);
    yield* responseToDispatchChunks(response);
  };
}
