/**
 * A hosted v8 save as the content-protocol route receives it: a JSON-RPC
 * request (one call or a batch) of `blocks.apply` calls only. The route
 * serves it from the draft alone (`createDraftWriteStorage`), with no
 * GitHub read; any other request takes the layered storage.
 */

import {
  serializeBlock,
  spellingKey,
  TOMBSTONE_VERSION,
} from "@decocms/blocks/protocol";
import type { DraftConflictBlocks } from "@decocms/shared/blocks-major";
import { gitBlobSha } from "@/decofile/read-decofile";
import type { DraftBody } from "./draft-store";

import {
  applyOnlyCalls,
  isRecord,
  type PreconditionRule,
  refuseUnguardedSave,
  saveRequestBody,
} from "./save-guards";

export {
  applyOnlyCalls,
  refuseUnguardedSave,
  saveRequestBody,
  type PreconditionRule,
};

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
function draftBlocksOf(
  draft: DraftBody,
  names: readonly string[],
): DraftConflictBlocks["draft"] {
  const out: DraftConflictBlocks["draft"] = {};
  for (const name of names) {
    const key = spellingKey(name);
    const setName = Object.keys(draft.set).find((n) => spellingKey(n) === key);
    if (setName !== undefined) {
      const block = draft.set[setName];
      out[name] = {
        block,
        version: gitBlobSha(serializeBlock(block)),
        editor: null,
      };
    } else if (draft.delete.some((n) => spellingKey(n) === key)) {
      out[name] = { block: null, version: TOMBSTONE_VERSION, editor: null };
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
 * flow from it. Any other answer is returned as it is.
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
  for (const [i, entries] of refused.entries()) {
    if (!entries) continue;
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
