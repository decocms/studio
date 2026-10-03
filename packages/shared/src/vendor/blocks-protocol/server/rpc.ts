/**
 * The JSON-RPC 2.0 layer: envelope validation, batches and dispatch.
 *
 * - Every request has an `id`; one without is rejected rather than run.
 * - A batch runs in order, returns results in order, holds at most 10 calls,
 *   and isn't atomic.
 * - The aggregate response is bounded: once it would pass
 *   `maxBatchResponseBytes`, later reads answer LimitExceeded instead.
 * - A write's response is never replaced, alone or in a batch: the write has
 *   landed, and answering LimitExceeded would tell the client it hadn't.
 */
import {
  type ContentProtocolError,
  internalError,
  invalidRequest,
  limitExceeded,
  methodNotFound,
} from "../errors";
import { validateParams } from "../params";
import {
  MAX_BATCH_CALLS,
  METHOD_NAMES,
  type MethodName,
  type RpcId,
} from "../types";
import { type Core, toProtocolError } from "./core";
import { blocksApply } from "./methods/apply";
import { blocksList, describe, schemaGet } from "./methods/read";

const utf8 = new TextEncoder();

type Envelope = { id: RpcId; method: MethodName; params: unknown };

const isMethod = (method: string): method is MethodName =>
  (METHOD_NAMES as readonly string[]).includes(method);

/** Validates one request object; returns the error response's id on failure. */
function parseEnvelope(
  value: unknown,
): Envelope | { error: ContentProtocolError; id: RpcId | null } {
  const isObject =
    typeof value === "object" && value !== null && !Array.isArray(value);
  const raw = (isObject ? value : {}) as Record<string, unknown>;
  const id =
    typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null;
  if (!isObject)
    return { error: invalidRequest("a request must be an object"), id: null };
  if (raw.jsonrpc !== "2.0")
    return { error: invalidRequest('jsonrpc must be "2.0"'), id };
  if (id === null) {
    return {
      error: invalidRequest("every request needs a string or number id"),
      id: null,
    };
  }
  if (typeof raw.method !== "string")
    return { error: invalidRequest("method must be a string"), id };
  for (const key of Object.keys(raw)) {
    if (!["jsonrpc", "id", "method", "params"].includes(key)) {
      return { error: invalidRequest(`unknown request member "${key}"`), id };
    }
  }
  if (!isMethod(raw.method)) return { error: methodNotFound(raw.method), id };
  return { id, method: raw.method, params: raw.params };
}

async function run(
  core: Core,
  envelope: Envelope,
  scope: string,
): Promise<unknown> {
  switch (envelope.method) {
    case "describe":
      validateParams("describe", envelope.params);
      return describe(core);
    case "schema.get":
      return schemaGet(core, validateParams("schema.get", envelope.params));
    case "blocks.list":
      return blocksList(core, validateParams("blocks.list", envelope.params));
    case "blocks.apply":
      return blocksApply(
        core,
        validateParams("blocks.apply", envelope.params),
        scope,
      );
  }
}

/** True for a well-formed `blocks.apply` request. */
function isWrite(value: unknown): boolean {
  const envelope = parseEnvelope(value);
  return !("error" in envelope) && envelope.method === "blocks.apply";
}

const errorResponse = (id: RpcId | null, error: ContentProtocolError) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: error.toJSON() });

async function call(
  core: Core,
  value: unknown,
  scope: string,
): Promise<string> {
  const envelope = parseEnvelope(value);
  if ("error" in envelope) return errorResponse(envelope.id, envelope.error);
  try {
    const result = await run(core, envelope, scope);
    return JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result });
  } catch (error) {
    const known = toProtocolError(error);
    if (known) return errorResponse(envelope.id, known);
    core.options.onError?.(error);
    return errorResponse(envelope.id, internalError());
  }
}

/**
 * Runs a parsed request body (one request object or a batch array) and
 * returns the serialized response body.
 */
export async function dispatch(
  core: Core,
  body: unknown,
  scope: string,
  maxResponseBytes: number,
) {
  if (!Array.isArray(body)) {
    const response = await call(core, body, scope);
    if (isWrite(body) || utf8.encode(response).byteLength <= maxResponseBytes)
      return response;
    return errorResponse(
      parseEnvelope(body).id,
      limitExceeded(`the response is over ${maxResponseBytes} bytes`, {
        limit: "maxBatchResponseBytes",
      }),
    );
  }
  if (body.length === 0)
    return errorResponse(null, invalidRequest("an empty batch"));
  if (body.length > MAX_BATCH_CALLS) {
    return errorResponse(
      null,
      limitExceeded(`a batch holds at most ${MAX_BATCH_CALLS} calls`, {
        limit: "maxBatchCalls",
      }),
    );
  }
  const responses: string[] = [];
  let total = 2; // the brackets
  for (const item of body) {
    const envelope = parseEnvelope(item);
    const id = envelope.id;
    const overBudget = () =>
      errorResponse(
        id,
        limitExceeded(`the batch response is over ${maxResponseBytes} bytes`, {
          limit: "maxBatchResponseBytes",
        }),
      );
    // Writes always run, so a batch never drops a save; reads stop once over budget.
    const write = !("error" in envelope) && envelope.method === "blocks.apply";
    let response =
      !write && total > maxResponseBytes
        ? overBudget()
        : await call(core, item, scope);
    const bytes = utf8.encode(response).byteLength + (responses.length ? 1 : 0);
    if (total + bytes > maxResponseBytes && !write) response = overBudget();
    total += utf8.encode(response).byteLength + (responses.length ? 1 : 0);
    responses.push(response);
  }
  return `[${responses.join(",")}]`;
}
