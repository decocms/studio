/**
 * A hosted v8 save as the content-protocol route receives it: a JSON-RPC
 * request (one call or a batch) of `blocks.apply` calls only. The route
 * serves it from the draft alone (`createDraftWriteStorage`), with no
 * GitHub read; any other request takes the layered storage.
 */

import { spellingKey } from "@decocms/blocks/protocol";
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

/**
 * The names the save deletes that `draft` doesn't hold, unguarded or
 * guarded "must not exist" (which the draft meets), and the request with
 * those guards dropped: the write storage lists each of them so the core
 * writes its delete (see `createDraftWriteStorage`). A delete guarded by a
 * version the draft doesn't hold is left as sent: the core answers a
 * Conflict. Malformed params are left for the core to report.
 */
export function planDraftSave(
  body: unknown,
  calls: ApplyCall[],
  draft: DraftBody,
): { body: unknown; deletes: string[] } {
  const held = new Set(Object.keys(draft.set).map(spellingKey));
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
        delete guards[name];
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
