/**
 * A hosted v8 save as the content-protocol route receives it: a JSON-RPC
 * request (one call or a batch) of `blocks.apply` calls only. The route
 * serves it from the draft alone (`createDraftWriteStorage`), with no
 * GitHub read; any other request takes the layered storage.
 */

import { serializeBlock, spellingKey } from "@decocms/blocks/protocol";
import {
  DRAFT_TOMBSTONE_VERSION,
  type DraftConflictBlocks,
} from "@decocms/shared/blocks-major";
import { gitBlobSha } from "@/decofile/read-decofile";
import { NOT_IN_DRAFT } from "./draft-content-storage";
import type { DraftBody } from "./draft-store";

interface ApplyCall {
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

function isApplyCall(value: unknown): value is ApplyCall {
  return (
    isRecord(value) &&
    value.method === "blocks.apply" &&
    (value.params === undefined || isRecord(value.params))
  );
}

/** The request's calls when every one is a `blocks.apply`; null otherwise. */
export function applyOnlyCalls(body: unknown): ApplyCall[] | null {
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || !calls.every(isApplyCall)) return null;
  return calls as ApplyCall[];
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
export function unguardedNames(call: ApplyCall): string[] {
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
 * A hosted v8 save must say, for every block it writes or deletes, which
 * version of the draft it was built on: a save without one could land over
 * someone else's change unseen. A request holding a `blocks.apply` that
 * misses one is refused whole (a batch answers each of its calls), with the
 * protocol's InvalidParams naming the blocks; nothing is written. Null when
 * every `blocks.apply` of the request is guarded (or there is none).
 */
export function refuseUnguardedSave(body: unknown): Response | null {
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
          ? 'A hosted save needs a precondition (ifMatch) for every block it writes or deletes: its version in the draft, null when the draft doesn\'t hold it, or "tombstone" when the draft deletes it'
          : "Not applied: another call of this batch has no precondition (ifMatch) for a block it touches",
      data: { missing: missing[i] },
    },
  }));
  return Response.json(Array.isArray(body) ? answers : answers[0]);
}

/**
 * The names the save deletes that `draft` doesn't hold (neither a block nor
 * a deletion of it: a block only main has), and the request with their
 * "must not exist" guards sent as {@link NOT_IN_DRAFT}: the write storage
 * lists each of them at that version so the core writes its delete (see
 * `createDraftWriteStorage`), and its commit checks the guard as "still not
 * in the draft", so a save that lands meanwhile is not deleted over. A
 * delete guarded by a version is left as sent: the core answers a Conflict
 * when the draft doesn't hold it. Malformed params are left for the core to
 * report.
 */
export function planDraftSave(
  body: unknown,
  calls: ApplyCall[],
  draft: DraftBody,
): { body: unknown; deletes: string[] } {
  const held = new Set(
    [...Object.keys(draft.set), ...draft.delete].map(spellingKey),
  );
  const deletes = new Set<string>();
  const rewritten = calls.map((call) => {
    const params = call.params;
    if (!params || !Array.isArray(params.delete)) return call;
    const sets = isRecord(params.set) ? params.set : {};
    const guards = isRecord(params.ifMatch) ? { ...params.ifMatch } : null;
    let changed = false;
    for (const name of params.delete) {
      if (typeof name !== "string" || Object.hasOwn(sets, name)) continue;
      if (held.has(spellingKey(name))) continue;
      if (guards && Object.hasOwn(guards, name)) {
        if (guards[name] !== null) continue;
        guards[name] = NOT_IN_DRAFT;
        changed = true;
      }
      deletes.add(name);
    }
    if (!changed) return call;
    return { ...call, params: { ...params, ifMatch: guards } };
  });
  return {
    body: Array.isArray(body) ? rewritten : rewritten[0],
    deletes: [...deletes],
  };
}

interface RpcAnswer {
  error?: { code?: unknown; data?: unknown };
}

/** The protocol's Conflict (`ErrorCode.Conflict`). */
const CONFLICT = -32002;

function conflictEntries(
  answer: unknown,
): Record<string, { expected?: unknown; actual?: unknown }> | null {
  if (!isRecord(answer)) return null;
  const error = (answer as RpcAnswer).error;
  if (!isRecord(error) || error.code !== CONFLICT) return null;
  const data = error.data;
  if (!isRecord(data) || !isRecord(data.entries)) return null;
  return data.entries as Record<
    string,
    { expected?: unknown; actual?: unknown }
  >;
}

/** Each name of `names` as `draft` holds it now (see `DraftConflictBlocks`). */
export function draftBlocksOf(
  draft: DraftBody,
  names: readonly string[],
): DraftConflictBlocks["draft"] {
  const out: DraftConflictBlocks["draft"] = {};
  for (const name of names) {
    const key = spellingKey(name);
    const setName = Object.keys(draft.set).find((n) => spellingKey(n) === key);
    if (setName !== undefined) {
      const block = draft.set[setName];
      out[name] = { block, version: gitBlobSha(serializeBlock(block)) };
    } else if (draft.delete.some((n) => spellingKey(n) === key)) {
      out[name] = { block: null, version: DRAFT_TOMBSTONE_VERSION };
    } else {
      out[name] = null;
    }
  }
  return out;
}

/**
 * A hosted save's answer as the editor gets it: a Conflict says what the
 * draft holds now for each refused block (`DraftConflictBlocks`, one read
 * of the draft object, never GitHub), so the editor opens its reconcile
 * flow from it, and a {@link NOT_IN_DRAFT} guard reads `null` again, as the
 * editor sent it. Any other answer is returned as it is.
 */
export async function withDraftConflicts(
  response: Response,
  loadDraft: () => Promise<DraftBody>,
): Promise<Response> {
  const text = await response.clone().text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return response;
  }
  const answers = Array.isArray(parsed) ? parsed : [parsed];
  const refused = answers.map(conflictEntries);
  if (refused.every((entries) => entries === null)) return response;
  const draft = await loadDraft();
  const shown = (version: unknown) =>
    version === NOT_IN_DRAFT ? null : version;
  for (const [i, entries] of refused.entries()) {
    if (!entries) continue;
    for (const entry of Object.values(entries)) {
      if (!isRecord(entry)) continue;
      entry.expected = shown(entry.expected);
      entry.actual = shown(entry.actual);
    }
    const data = (answers[i] as { error: { data: Record<string, unknown> } })
      .error.data;
    data.draft = draftBlocksOf(draft, Object.keys(entries));
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(parsed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
