/**
 * The hosted draft's JSON-RPC endpoint (contract §4.2): the content
 * protocol's handler plus Studio's two methods, `cms.index` and
 * `cms.blocks`, answered here before the rest of a batch reaches the
 * handler; the answers come back merged in request order.
 *
 * Each protocol call goes to the handler on its own (a batch runs in order
 * and isn't atomic, so this is the same batch), which lets each
 * `blocks.apply` answer carry what only its own commit knows: a Conflict
 * gets each refused block as the draft held it in that save's read
 * (`DraftConflictBlocks`), and an Unavailable after a partial write gets
 * `data.landed`, the names that were written.
 */

import {
  ContentProtocolError,
  ErrorCode,
  invalidParams,
  invalidRequest,
  MAX_BATCH_CALLS,
  StorageUnavailableError,
  unavailable,
} from "@decocms/blocks/protocol";
import type { ContentHandler } from "@decocms/blocks/protocol/server";
import {
  type CmsStorage,
  conflictBlocks,
  MAX_NAMES_PER_BLOCKS,
} from "./cms-storage";

const STUDIO_METHODS = new Set(["cms.index", "cms.blocks"]);

type RpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The block names a request's `blocks.apply` calls write, delete or guard:
 * the only draft files a save reads (`writeSnapshot`).
 */
export function applyNamesOf(body: unknown): string[] {
  const names = new Set<string>();
  for (const call of Array.isArray(body) ? body : [body]) {
    if (!isRecord(call) || call.method !== "blocks.apply") continue;
    const params = isRecord(call.params) ? call.params : {};
    if (isRecord(params.set))
      for (const n of Object.keys(params.set)) names.add(n);
    if (isRecord(params.ifMatch))
      for (const n of Object.keys(params.ifMatch)) names.add(n);
    if (Array.isArray(params.delete)) {
      for (const n of params.delete) if (typeof n === "string") names.add(n);
    }
  }
  return [...names].filter((n) => n.length > 0).sort();
}

function idOf(call: unknown): RpcId {
  return isRecord(call) &&
    (typeof call.id === "string" || typeof call.id === "number")
    ? call.id
    : null;
}

function errorAnswer(id: RpcId, error: ContentProtocolError) {
  return { jsonrpc: "2.0", id, error: error.toJSON() };
}

function parseIndexParams(params: unknown): { ifNoneMatch?: string } {
  if (params === undefined) return {};
  if (!isRecord(params)) throw invalidParams("params must be an object");
  for (const key of Object.keys(params)) {
    if (key !== "ifNoneMatch") throw invalidParams(`unknown param "${key}"`);
  }
  if (
    params.ifNoneMatch !== undefined &&
    typeof params.ifNoneMatch !== "string"
  ) {
    throw invalidParams("ifNoneMatch must be a string");
  }
  return params.ifNoneMatch === undefined
    ? {}
    : { ifNoneMatch: params.ifNoneMatch };
}

function parseBlocksParams(params: unknown): string[] {
  if (!isRecord(params) || !Array.isArray(params.names)) {
    throw invalidParams("params.names must be an array of block names");
  }
  for (const key of Object.keys(params)) {
    if (key !== "names") throw invalidParams(`unknown param "${key}"`);
  }
  const names = params.names;
  if (names.length === 0 || names.length > MAX_NAMES_PER_BLOCKS) {
    throw invalidParams(
      `cms.blocks takes 1 to ${MAX_NAMES_PER_BLOCKS} names; got ${names.length}`,
      { limit: MAX_NAMES_PER_BLOCKS },
    );
  }
  if (!names.every((n): n is string => typeof n === "string" && n.length > 0)) {
    throw invalidParams("every name must be a non-empty string");
  }
  return names;
}

/** One `cms.index` or `cms.blocks` call, answered from the storage. */
async function answerStudioCall(
  storage: CmsStorage,
  call: Record<string, unknown>,
  onError: (error: unknown) => void,
) {
  const id = idOf(call);
  if (call.jsonrpc !== "2.0") {
    return errorAnswer(id, invalidRequest('jsonrpc must be "2.0"'));
  }
  if (id === null) {
    return errorAnswer(
      null,
      invalidRequest("every request needs a string or number id"),
    );
  }
  try {
    const result =
      call.method === "cms.index"
        ? await storage.index(parseIndexParams(call.params).ifNoneMatch)
        : await storage.blocks(parseBlocksParams(call.params));
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (error instanceof ContentProtocolError) return errorAnswer(id, error);
    if (error instanceof StorageUnavailableError) {
      return errorAnswer(id, unavailable(error.message, error.retryAfterMs));
    }
    onError(error);
    return errorAnswer(
      id,
      new ContentProtocolError(ErrorCode.InternalError, "internal error"),
    );
  }
}

/** One protocol call through the handler, with its save's own extras. */
async function answerProtocolCall(
  storage: CmsStorage,
  handler: ContentHandler,
  url: string,
  call: unknown,
): Promise<unknown> {
  const readsBefore = storage.applyReads.length;
  storage.takePartial();
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call),
    }),
  );
  const answer = (await response.json()) as {
    error?: { code?: number; data?: unknown };
  };
  const isApply = isRecord(call) && call.method === "blocks.apply";
  const error = answer?.error;
  if (!isApply || !error) return answer;
  if (error.code === ErrorCode.Conflict) {
    const read =
      storage.applyReads.length > readsBefore
        ? storage.applyReads.at(-1)
        : undefined;
    const data = isRecord(error.data) ? error.data : null;
    if (read && data && isRecord(data.entries)) {
      data.draft = conflictBlocks(read, Object.keys(data.entries));
    }
  } else if (error.code === ErrorCode.Unavailable) {
    const landed = storage.takePartial();
    if (landed) {
      error.data = { ...(isRecord(error.data) ? error.data : {}), landed };
    }
  }
  return answer;
}

/**
 * Answers a request body that is one call or a batch. A body the handler
 * must refuse whole (an empty batch, one over the batch limit) goes to it
 * as is.
 */
export async function dispatchCmsRpc(
  storage: CmsStorage,
  handler: ContentHandler,
  request: Request,
  body: unknown,
  onError: (error: unknown) => void = () => {},
): Promise<Response> {
  const batch = Array.isArray(body);
  const calls = batch ? body : [body];
  if (batch && (calls.length === 0 || calls.length > MAX_BATCH_CALLS)) {
    return handler(request);
  }
  const answers: unknown[] = [];
  for (const call of calls) {
    if (
      isRecord(call) &&
      typeof call.method === "string" &&
      STUDIO_METHODS.has(call.method)
    ) {
      answers.push(await answerStudioCall(storage, call, onError));
    } else {
      answers.push(
        await answerProtocolCall(storage, handler, request.url, call),
      );
    }
  }
  return Response.json(batch ? answers : answers[0]);
}
