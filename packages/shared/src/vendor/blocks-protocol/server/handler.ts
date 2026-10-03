/**
 * `createContentHandler(storage)`: the content protocol as a fetch handler,
 * `(Request) => Promise<Response>`.
 *
 * `POST <endpoint>` with `Content-Type: application/json` and a body that's
 * one request object or a batch array. Errors come back in the JSON-RPC
 * `error` object with HTTP 200, except a missing or invalid bearer token (401)
 * and a body over the size limit (413), which apply to the whole batch, and
 * requests that aren't the protocol at all: a method other than POST (405),
 * or a body that isn't JSON or uses an unsupported encoding (415). Those carry
 * a JSON-RPC error body too, with a `null` id.
 * Responses are gzip-compressed when the request accepts it.
 *
 * The handler is path-agnostic: mount it where the endpoint lives (`/rpc` on
 * the local server). Transport security that depends on where it runs — CORS,
 * `Host` checks, Chrome's local-network preflight — belongs to the server
 * that mounts it (`deco serve`).
 */
import {
  type ContentProtocolError,
  forbidden,
  invalidRequest,
  limitExceeded,
  parseError,
  unauthorized,
} from "../errors";
import type { ContentStorage } from "../storage";
import { assertAuthOptions, authenticate } from "./auth";
import { type ContentHandlerOptions, Core } from "./core";
import {
  BodyEncodingError,
  BodyTooLargeError,
  isJsonContentType,
  jsonResponse,
  readBody,
} from "./http";
import { dispatch } from "./rpc";

export type ContentHandler = (request: Request) => Promise<Response>;

const errorBody = (error: ContentProtocolError) =>
  JSON.stringify({ jsonrpc: "2.0", id: null, error: error.toJSON() });

export function createContentHandler(
  storage: ContentStorage,
  options: ContentHandlerOptions = {},
): ContentHandler {
  assertAuthOptions(options);
  const core = new Core(storage, options);

  return async (request) => {
    if (request.method !== "POST") {
      return jsonResponse(request, errorBody(invalidRequest("use POST")), 405, {
        allow: "POST",
      });
    }
    const auth = await authenticate(request, options);
    if (!auth.ok) {
      return auth.reason === "unauthorized"
        ? jsonResponse(request, errorBody(unauthorized()), 401, {
            "www-authenticate": 'Bearer realm="deco-content"',
          })
        : jsonResponse(request, errorBody(forbidden()));
    }
    if (!isJsonContentType(request)) {
      return jsonResponse(
        request,
        errorBody(invalidRequest("Content-Type must be application/json")),
        415,
      );
    }

    const limits = core.limits(await core.description());
    let bytes: Uint8Array;
    try {
      bytes = await readBody(request, limits.maxRequestBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return jsonResponse(
          request,
          errorBody(
            limitExceeded(
              `the request body is over ${limits.maxRequestBytes} bytes`,
              {
                limit: "maxRequestBytes",
              },
            ),
          ),
          413,
        );
      }
      if (error instanceof BodyEncodingError) {
        return jsonResponse(
          request,
          errorBody(invalidRequest(error.message)),
          415,
        );
      }
      throw error;
    }

    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return jsonResponse(request, errorBody(parseError()));
    }
    const response = await dispatch(
      core,
      body,
      auth.scope,
      limits.maxBatchResponseBytes,
    );
    return jsonResponse(request, response);
  };
}
