/**
 * `createAssetHandler(storage)`: uploads beside the content protocol.
 *
 * Uploads aren't one of the four methods. The site editor sends each file to
 * `PUT /assets/<name>` with the same token as the protocol; on that path the
 * file's own image, video, font or PDF content type is accepted instead of
 * JSON, and the name's extension must match it (`banner.html` sent as
 * `image/png` is refused; a name without an extension gets the type's). SVG
 * is refused unless `allowSvg` is set, since it can carry scripts that would
 * run on the site's origin. The storage writes it to its asset folder, never overwriting an
 * existing file (a taken name gets a short suffix), and the response carries
 * the path the site editor stores in the field: always `/assets/<name>`.
 */

import {
  type AssetTypeOptions,
  assetNameForType,
  isAcceptedAssetType,
  sanitizeAssetName,
} from "../assets";
import {
  type ContentProtocolError,
  ErrorCode,
  forbidden,
  invalidRequest,
  limitExceeded,
  readOnly,
  unauthorized,
  unsupported,
} from "../errors";
import type { ContentStorage } from "../storage";
import { ASSETS_URL_PREFIX } from "../types";
import { type AuthOptions, assertAuthOptions, authenticate } from "./auth";
import {
  BodyEncodingError,
  BodyTooLargeError,
  jsonResponse,
  readBody,
} from "./http";

const STATUS: Record<number, number> = {
  [ErrorCode.Unauthorized]: 401,
  [ErrorCode.Forbidden]: 403,
  [ErrorCode.ReadOnly]: 403,
  [ErrorCode.Unsupported]: 404,
  [ErrorCode.LimitExceeded]: 413,
  [ErrorCode.InvalidRequest]: 400,
};

export type AssetHandler = (request: Request) => Promise<Response>;

export type AssetHandlerOptions = AuthOptions & AssetTypeOptions;

export function createAssetHandler(
  storage: ContentStorage,
  options: AssetHandlerOptions = {},
): AssetHandler {
  assertAuthOptions(options);
  const fail = (
    request: Request,
    error: ContentProtocolError,
    status?: number,
  ) =>
    jsonResponse(
      request,
      JSON.stringify({ error: error.toJSON() }),
      status ?? STATUS[error.code] ?? 400,
    );

  return async (request) => {
    if (request.method !== "PUT") {
      return jsonResponse(
        request,
        JSON.stringify({ error: invalidRequest("use PUT").toJSON() }),
        405,
        {
          allow: "PUT",
        },
      );
    }
    const auth = await authenticate(request, options);
    if (!auth.ok)
      return fail(
        request,
        auth.reason === "unauthorized" ? unauthorized() : forbidden(),
      );

    const description = await storage.describe();
    if (description.readOnly) return fail(request, readOnly());
    if (description.assets === null || !storage.putAsset) {
      return fail(request, unsupported("this endpoint doesn't accept uploads"));
    }
    const contentType = request.headers.get("content-type");
    if (!isAcceptedAssetType(contentType, options)) {
      return fail(
        request,
        invalidRequest("uploads must be an image, video, font or PDF"),
        415,
      );
    }
    const path = new URL(request.url).pathname;
    const marker = path.lastIndexOf(ASSETS_URL_PREFIX);
    const sanitized =
      marker === -1
        ? null
        : sanitizeAssetName(path.slice(marker + ASSETS_URL_PREFIX.length));
    if (!sanitized)
      return fail(
        request,
        invalidRequest("PUT /assets/<name> needs a file name"),
      );
    const name = assetNameForType(sanitized, contentType, options);
    if (!name) {
      return fail(
        request,
        invalidRequest(
          `the file name's extension doesn't match its content type (${contentType})`,
        ),
        415,
      );
    }

    const maxBytes = description.assets.maxBytes;
    let body: Uint8Array;
    try {
      body = await readBody(request, maxBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return fail(
          request,
          limitExceeded(`uploads are limited to ${maxBytes} bytes`),
        );
      }
      if (error instanceof BodyEncodingError)
        return fail(request, invalidRequest(error.message), 415);
      throw error;
    }
    if (body.byteLength === 0)
      return fail(request, invalidRequest("the upload is empty"));
    const stored = await storage.putAsset(name, body);
    return jsonResponse(
      request,
      JSON.stringify({ path: `${ASSETS_URL_PREFIX}${stored.name}` }),
      201,
    );
  };
}
