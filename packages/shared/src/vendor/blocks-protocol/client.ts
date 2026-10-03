/**
 * A small content-protocol client: one method per protocol method, plus
 * batches. Uses `fetch`, so it runs in browsers, on Workers and on Node.
 */
import { ContentProtocolError, ErrorCode, type RpcErrorObject } from "./errors";
import {
  type DescribeResult,
  type MethodName,
  type Methods,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type RpcId,
} from "./types";

export interface ContentClientOptions {
  /** The endpoint URL, such as `http://127.0.0.1:4545/rpc`. */
  endpoint: string | URL;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** A fetch implementation (defaults to the global one). */
  fetch?: (input: Request) => Promise<Response>;
}

/** One call of a batch. */
export type BatchCall = {
  [M in MethodName]: { method: M; params?: Methods[M]["params"] };
}[MethodName];

/** The outcome of one batch call: its result or its error. */
export type BatchOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: ContentProtocolError };

export interface ContentClient {
  /** Throws Unsupported when the endpoint speaks another protocol or major version. */
  describe(): Promise<Methods["describe"]["result"]>;
  schemaGet(
    params?: Methods["schema.get"]["params"],
  ): Promise<Methods["schema.get"]["result"]>;
  blocksList(
    params?: Methods["blocks.list"]["params"],
  ): Promise<Methods["blocks.list"]["result"]>;
  blocksApply(
    params: Methods["blocks.apply"]["params"],
  ): Promise<Methods["blocks.apply"]["result"]>;
  /** Calls one method by name. Throws `ContentProtocolError` on an error response. */
  call<M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ): Promise<Methods[M]["result"]>;
  /** Runs several calls in one request; outcomes come back in order. */
  batch(calls: BatchCall[]): Promise<BatchOutcome[]>;
}

type WireResponse = {
  id: RpcId | null;
  result?: unknown;
  error?: RpcErrorObject;
};

/**
 * Decodes a JSON response body, gunzipping it when a custom fetch (such as an
 * in-process handler) handed back the raw gzip bytes.
 */
export async function readResponseJson(response: Response): Promise<unknown> {
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      );
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Refuses an endpoint this client can't speak to: another protocol, or
 * another major version (minors only add, so any minor is fine).
 */
export function assertSupportedEndpoint(
  description: DescribeResult,
): DescribeResult {
  const { protocol, version } = (description ?? {}) as Partial<DescribeResult>;
  if (protocol !== PROTOCOL_NAME) {
    throw new ContentProtocolError(
      ErrorCode.Unsupported,
      `the endpoint speaks ${JSON.stringify(protocol)}, not ${PROTOCOL_NAME}`,
    );
  }
  if (version?.major !== PROTOCOL_VERSION.major) {
    throw new ContentProtocolError(
      ErrorCode.Unsupported,
      `the endpoint speaks ${PROTOCOL_NAME} ${String(version?.major)}.x; this client speaks ${PROTOCOL_VERSION.major}.x`,
    );
  }
  return description;
}

export function createContentClient(
  options: ContentClientOptions,
): ContentClient {
  const doFetch = options.fetch ?? ((request: Request) => fetch(request));
  let nextId = 1;

  async function post(body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...options.headers,
    };
    if (options.token !== undefined)
      headers.authorization = `Bearer ${options.token}`;
    const response = await doFetch(
      new Request(options.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    let payload: unknown;
    try {
      payload = await readResponseJson(response);
    } catch {
      throw new ContentProtocolError(
        ErrorCode.Unavailable,
        `the endpoint answered HTTP ${response.status} without a JSON-RPC body`,
      );
    }
    if (
      !response.ok ||
      (!Array.isArray(payload) && (payload as WireResponse)?.id === null)
    ) {
      const error = (payload as WireResponse)?.error;
      if (error) throw ContentProtocolError.from(error);
      throw new ContentProtocolError(
        ErrorCode.Unavailable,
        `the endpoint answered HTTP ${response.status}`,
      );
    }
    return payload;
  }

  const call = async <M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ) => {
    const id = nextId++;
    const response = (await post({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    })) as WireResponse;
    if (response.error) throw ContentProtocolError.from(response.error);
    return response.result as Methods[M]["result"];
  };

  return {
    call,
    describe: async () => assertSupportedEndpoint(await call("describe")),
    schemaGet: (params) => call("schema.get", params),
    blocksList: (params) => call("blocks.list", params),
    blocksApply: (params) => call("blocks.apply", params),
    async batch(calls) {
      const ids = calls.map(() => nextId++);
      const responses = (await post(
        calls.map((c, i) => ({
          jsonrpc: "2.0",
          id: ids[i],
          method: c.method,
          params: c.params ?? {},
        })),
      )) as WireResponse[];
      const byId = new Map(responses.map((r) => [r.id, r]));
      return ids.map((id): BatchOutcome => {
        const response = byId.get(id);
        if (!response) {
          return {
            ok: false,
            error: new ContentProtocolError(
              ErrorCode.InternalError,
              "no response for this call",
            ),
          };
        }
        return response.error
          ? { ok: false, error: ContentProtocolError.from(response.error) }
          : { ok: true, result: response.result };
      });
    },
  };
}
