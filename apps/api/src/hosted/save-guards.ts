/**
 * The save guards a hosted content-protocol route runs before the content
 * handler (no git, no draft read): which calls a request makes, the
 * request's size limit, and the refusal of a `blocks.apply` that misses a
 * precondition for a block it touches.
 */

export interface ApplyCall {
  method: "blocks.apply";
  params?: {
    set?: unknown;
    delete?: unknown;
    ifMatch?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isApplyCall(value: unknown): value is ApplyCall {
  return (
    isRecord(value) &&
    value.method === "blocks.apply" &&
    (value.params === undefined || isRecord(value.params))
  );
}

/** The protocol's InvalidParams (`ErrorCode.InvalidParams`). */
const INVALID_PARAMS = -32602;

/** A precondition entry: a version, `null` ("not in the draft") or the tombstone's. */
function isPrecondition(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length > 0);
}

/**
 * The names a `blocks.apply` call writes or deletes with no precondition
 * of its own (`ifMatch` lacks them, or holds something else than a version,
 * `null` or the tombstone's). Malformed params are left for the core.
 */
function unguardedNames(call: ApplyCall): string[] {
  const params = call.params ?? {};
  const guards = isRecord(params.ifMatch) ? params.ifMatch : {};
  const names = [
    ...(isRecord(params.set) ? Object.keys(params.set) : []),
    ...(Array.isArray(params.delete)
      ? params.delete.filter((n): n is string => typeof n === "string")
      : []),
  ];
  return [...new Set(names)].filter(
    (name) => !Object.hasOwn(guards, name) || !isPrecondition(guards[name]),
  );
}

/**
 * The protocol's request size limit (`MAX_REQUEST_BYTES` of the content
 * handler, not exported by the package): a body over it is the handler's
 * HTTP 413 LimitExceeded, never read here.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * A save request's JSON body, or undefined when it isn't JSON or is over the
 * protocol's size limit: the content handler answers that one (413) itself,
 * before any check of the route's.
 */
export async function saveRequestBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return undefined;
  const text = await request.clone().text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Which versions a save's preconditions name: the editor's save (`draft`,
 * `serveDraftSave`) guards each block by the draft alone; a save through
 * main (`site`, the layered storage) by the version `blocks.list` reports,
 * main's under the draft.
 */
export type PreconditionRule = "draft" | "site";

const MISSING_PRECONDITION: Record<PreconditionRule, string> = {
  draft:
    'A hosted save needs a precondition (ifMatch) for every block it writes or deletes: its version in the draft, null when the draft doesn\'t hold it, or "tombstone" when the draft deletes it',
  site: "A hosted save needs a precondition (ifMatch) for every block it writes or deletes: its version as blocks.list reports it, or null when the site doesn't have it",
};

/**
 * A hosted v8 save must say, for every block it writes or deletes, which
 * version it was built on (see {@link PreconditionRule}): a save without one
 * could land over someone else's change unseen. A request holding a
 * `blocks.apply` that misses one is refused whole (a batch answers each of
 * its calls), with the protocol's InvalidParams naming the blocks; nothing
 * is written. Null when every `blocks.apply` of the request is guarded (or
 * there is none).
 */
export function refuseUnguardedSave(
  body: unknown,
  rule: PreconditionRule,
): Response | null {
  const calls = Array.isArray(body) ? body : [body];
  const missing = calls.map((call) =>
    isApplyCall(call) ? unguardedNames(call) : [],
  );
  if (missing.every((names) => names.length === 0)) return null;
  const answers = calls.map((call, i) => ({
    jsonrpc: "2.0",
    id: isRecord(call) && "id" in call ? call.id : null,
    error: {
      code: INVALID_PARAMS,
      message:
        missing[i]!.length > 0
          ? MISSING_PRECONDITION[rule]
          : "Not applied: another call of this batch has no precondition (ifMatch) for a block it touches",
      data: { missing: missing[i] },
    },
  }));
  return Response.json(Array.isArray(body) ? answers : answers[0]);
}
