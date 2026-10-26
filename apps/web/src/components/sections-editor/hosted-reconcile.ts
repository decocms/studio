/**
 * Every hosted v8 write (Studio's draft, `backend.source === "github"`) is
 * checked against the draft alone: each block it touches carries the version
 * the draft holds it at (`protocolBlockVersion`: a version, `null` for "must
 * not exist in the draft", the tombstone's for a block the draft deletes).
 * A refusal always opens the reconcile flow (named-rule-conflict.tsx): values
 * only one side changed merge on their own, the rest is the user's choice,
 * and a block one side deleted is one plain question. Nothing is written
 * over someone else's change, and no edit is dropped, without that choice.
 *
 * This module holds what the write hooks share: the plan of a refused change
 * (one record keyed by block name), the question, and the loop that writes
 * a change of several blocks (a delete, a move).
 */

import type { QueryClient } from "@tanstack/react-query";
import { canonicalBlockJson } from "@decocms/shared/decofile";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { KEYS } from "@/lib/query-keys";
import type { ProtocolBackend } from "./content-backend";
import {
  adoptRefusedDraft,
  applyProtocolPatch,
  protocolBlockVersion,
  reloadProtocolBlock,
  rereadProtocolContent,
} from "./content-protocol-api";
import type { DecofileScopeParams } from "./decofile-api";
import {
  type ConflictChoices,
  conflictFields,
  type FormConflictPlan,
  planFormConflict,
  resolveFormConflict,
} from "./form-conflict";
import {
  askDeletedConflict,
  askNamedRuleConflict,
  canAskNamedRuleConflict,
  type DeletedConflict,
} from "./named-rule-conflict";
import type { SchemaProperty } from "./resolve-schema";
import { isSaveConflict } from "./serve-save-error";

/** Blocks written whole, and blocks removed. */
export interface HostedChange {
  writes: Record<string, Record<string, unknown>>;
  deletes: string[];
}

/**
 * The user kept what the draft holds (their version, or their deletion):
 * nothing of the change was written. Not a failure: the dialog was the
 * answer, so callers show at most {@link toastKeptTheirs}'s one toast.
 */
export class HostedKeptTheirsError extends Error {
  constructor(
    /** A block the draft deletes stayed deleted. */
    readonly deleted: boolean,
  ) {
    super("kept their version");
    this.name = "HostedKeptTheirsError";
  }
}

/** How many times one change is reconciled before the editor stops asking. */
export const HOSTED_RECONCILE_ROUNDS = 3;

/**
 * A refused change as one record keyed by block name: the copies it was
 * built on (`copies`), the change, and what the draft holds now. Values only
 * one side changed merge on their own; a value both changed, or a block one
 * side removed and the other changed, is the user's choice.
 */
export function planHostedConflict(
  blockKeys: readonly string[],
  copies: Record<string, unknown> | undefined,
  change: HostedChange,
  stored: Record<string, unknown>,
): FormConflictPlan {
  const ancestor: Record<string, unknown> = {};
  const mine: Record<string, unknown> = {};
  const theirs: Record<string, unknown> = {};
  for (const key of blockKeys) {
    if (copies && Object.hasOwn(copies, key)) ancestor[key] = copies[key];
    if (Object.hasOwn(change.writes, key)) mine[key] = change.writes[key];
    if (Object.hasOwn(stored, key)) theirs[key] = stored[key];
  }
  return planFormConflict({ ancestor, mine, theirs });
}

/** The change to write once the user chose (see {@link planHostedConflict}). */
export function hostedChangeFromResolved(
  blockKeys: readonly string[],
  resolved: Record<string, unknown>,
  stored: Record<string, unknown>,
): HostedChange {
  const writes: Record<string, Record<string, unknown>> = {};
  const deletes: string[] = [];
  for (const key of blockKeys) {
    const value = resolved[key];
    if (isRecord(value)) writes[key] = value;
    else if (Object.hasOwn(stored, key)) deletes.push(key);
  }
  return { writes, deletes };
}

/** True when `change` leaves every block it touches as `stored` has it. */
export function changeKeepsStored(
  change: HostedChange,
  stored: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(change.writes)) {
    if (!Object.hasOwn(stored, key)) return false;
    if (canonicalBlockJson(stored[key]) !== canonicalBlockJson(value)) {
      return false;
    }
  }
  return change.deletes.every((key) => !Object.hasOwn(stored, key));
}

/** How the reconcile dialog names a block: its `name`, else its key. */
export function blockLabel(blockKey: string, ...copies: unknown[]): string {
  for (const copy of copies) {
    if (isRecord(copy) && typeof copy.name === "string" && copy.name.trim()) {
      return copy.name.trim();
    }
  }
  return blockKey;
}

/**
 * The blocks a move takes its copy from that are deleted now (`deleted`):
 * a change that creates blocks (written, absent from the copies it was
 * built on) and deletes others is a move or a rename, and writing it would
 * bring a block someone deleted back under its new name. Empty for a change
 * that creates nothing (a delete, a save of existing blocks).
 */
export function deletedMoveSources(
  change: HostedChange,
  copies: Record<string, unknown> | undefined,
  deleted: (blockKey: string) => boolean,
): string[] {
  const creates = Object.keys(change.writes).some(
    (key) => !copies || !Object.hasOwn(copies, key),
  );
  if (!creates) return [];
  return change.deletes.filter(
    (key) => !Object.hasOwn(change.writes, key) && deleted(key),
  );
}

/**
 * A move of blocks someone deleted meanwhile: "Keep my version" (the move
 * is written, its deleted sources left as they are) or "Leave it deleted"
 * (nothing is written: {@link HostedKeptTheirsError}).
 */
async function askMovedDeleted(
  change: HostedChange,
  copies: Record<string, unknown> | undefined,
  sources: string[],
): Promise<HostedChange> {
  const created = Object.keys(change.writes)
    .filter((key) => !copies || !Object.hasOwn(copies, key))
    .map((key) => change.writes[key]);
  const source = sources[0]!;
  const choice = await askDeletedConflict({
    kind: "theyDeleted",
    label: blockLabel(source, ...created, copies?.[source]),
  });
  if (choice === "theirs") throw new HostedKeptTheirsError(true);
  return {
    writes: change.writes,
    deletes: change.deletes.filter((key) => !sources.includes(key)),
  };
}

/**
 * The plan's one question when it is about a whole block one side deleted
 * (its only value in conflict is the block itself, missing on one side).
 */
function deletedBlockQuestion(
  plan: FormConflictPlan,
): { pointer: string; conflict: DeletedConflict } | null {
  if (plan.pointers.length !== 1) return null;
  const pointer = plan.pointers[0]!;
  const parts = pointer.split("/");
  if (parts.length !== 2) return null;
  const key = parts[1]!.replaceAll("~1", "/").replaceAll("~0", "~");
  const mine = plan.mine[key];
  const theirs = plan.theirs[key];
  if ((mine === undefined) === (theirs === undefined)) return null;
  return {
    pointer,
    conflict: {
      kind: theirs === undefined ? "theyDeleted" : "youDeleted",
      label: blockLabel(key, mine, theirs, plan.ancestor[key]),
    },
  };
}

/** Asks the plan's question: the deleted-block one, or value by value. */
export async function askHostedConflict(
  plan: FormConflictPlan,
  labels?: SchemaProperty | null,
): Promise<ConflictChoices> {
  const deleted = deletedBlockQuestion(plan);
  if (deleted) {
    return { [deleted.pointer]: await askDeletedConflict(deleted.conflict) };
  }
  return askNamedRuleConflict(plan, conflictFields(plan, labels));
}

/** True when every choice made keeps their version. */
export function choseTheirs(choices: ConflictChoices): boolean {
  const picks = Object.values(choices);
  return picks.length > 0 && picks.every((choice) => choice === "theirs");
}

interface HostedWriteContext {
  queryClient: QueryClient;
  backend: ProtocolBackend;
  params: DecofileScopeParams;
  cacheKey: string;
}

/**
 * The draft's version of each block, as a hosted write's `ifMatch`. A
 * version not known yet (the draft's changes weren't read) is read first;
 * still unknown, the write fails rather than going out unguarded.
 */
export async function hostedIfMatch(
  ctx: HostedWriteContext,
  blockKeys: readonly string[],
): Promise<Record<string, string | null>> {
  const versionOf = (key: string) =>
    protocolBlockVersion(ctx.queryClient, ctx.cacheKey, key, ctx.backend);
  if (blockKeys.some((key) => versionOf(key) === undefined)) {
    await rereadProtocolContent(
      ctx.queryClient,
      ctx.backend,
      ctx.params,
      ctx.cacheKey,
    );
  }
  const ifMatch: Record<string, string | null> = {};
  for (const key of blockKeys) {
    const version = versionOf(key);
    if (version === undefined) {
      throw new Error("The draft's changes couldn't be read");
    }
    ifMatch[key] = version;
  }
  return ifMatch;
}

/**
 * Puts the draft's copies of a refused write's blocks in the cache: from
 * the refusal when it carries them, else read. Returns the cache's blocks.
 */
async function adoptRefusal(
  ctx: HostedWriteContext,
  blockKeys: readonly string[],
  refusal: unknown,
  copies: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  // The cache holds the change itself (written ahead of the save): its
  // blocks go back to the copies it was built on, which the draft still
  // holds unless the refusal says otherwise (its copies replace them next).
  if (copies) {
    setCachedBlocks(ctx, blockKeys, (key) =>
      Object.hasOwn(copies, key) ? { value: copies[key] } : null,
    );
  }
  if (!adoptRefusedDraft(ctx.queryClient, ctx.backend, ctx.cacheKey, refusal)) {
    for (const key of blockKeys) {
      await reloadProtocolBlock(
        ctx.queryClient,
        ctx.backend,
        ctx.params,
        ctx.cacheKey,
        key,
        refusal,
      );
    }
  }
  return (
    ctx.queryClient.getQueryData<Record<string, unknown>>(
      KEYS.decofile(ctx.cacheKey),
    ) ?? {}
  );
}

/**
 * Writes a change of several blocks (a delete, a move) to the hosted draft
 * in one guarded `blocks.apply`. Refused: the reconcile flow asks, and the
 * user's picks are written guarded again. Resolves with the change written;
 * rejects with {@link HostedKeptTheirsError} when the user kept the draft's
 * blocks (the cache holds them), and with the refusal when the flow can't
 * ask or gave up.
 */
export async function applyHostedChange(
  ctx: HostedWriteContext,
  change: HostedChange,
  copies: Record<string, unknown> | undefined,
): Promise<{
  revision: string;
  versions: Record<string, string | null>;
  change: HostedChange;
}> {
  let current = change;
  let base = copies;
  for (let round = 0; ; round++) {
    const deletes = current.deletes.filter(
      (key) => !Object.hasOwn(current.writes, key),
    );
    const touched = [...Object.keys(current.writes), ...deletes];
    const ifMatch = await hostedIfMatch(ctx, touched);
    // A move whose source the draft deletes already (a poll brought the
    // deletion; the editor still showed the block): its guard would pass,
    // and the move would bring the block back. Asked first, as a refusal.
    const moved = deletedMoveSources(
      current,
      base,
      (key) => ifMatch[key] === DRAFT_TOMBSTONE_VERSION,
    );
    if (moved.length > 0) {
      try {
        if (!canAskNamedRuleConflict()) throw new HostedKeptTheirsError(true);
        current = await askMovedDeleted(current, base, moved);
      } catch (error) {
        // Left deleted: the editor shows the draft, which has the block
        // under neither name.
        setCachedBlocks(ctx, touched, (key) =>
          moved.includes(key) || !base || !Object.hasOwn(base, key)
            ? null
            : { value: base[key] },
        );
        throw error;
      }
      continue;
    }
    try {
      const result = await applyProtocolPatch(
        ctx.queryClient,
        ctx.backend,
        ctx.params,
        ctx.cacheKey,
        {
          set: current.writes,
          ...(deletes.length > 0 ? { delete: deletes } : {}),
        },
        ifMatch,
      );
      // The editor shows what was written (a reconciled change differs
      // from the one put in the cache ahead of the save).
      setCachedBlocks(ctx, touched, (key) =>
        Object.hasOwn(current.writes, key)
          ? { value: current.writes[key] }
          : null,
      );
      return { ...result, change: current };
    } catch (error) {
      if (!isSaveConflict(error)) throw error;
      const stored = await adoptRefusal(ctx, touched, error, base);
      if (round + 1 >= HOSTED_RECONCILE_ROUNDS || !canAskNamedRuleConflict()) {
        throw error;
      }
      // A move of a block someone deleted meanwhile: the plan would see
      // nothing in conflict (both sides dropped the source) and write the
      // move, bringing the block back. Their deletion is asked about first.
      const movedAway = deletedMoveSources(
        current,
        base,
        (key) =>
          !!base && Object.hasOwn(base, key) && !Object.hasOwn(stored, key),
      );
      if (movedAway.length > 0) {
        current = await askMovedDeleted(current, base, movedAway);
        base = Object.fromEntries(
          touched
            .filter((key) => Object.hasOwn(stored, key))
            .map((key) => [key, stored[key]]),
        );
        continue;
      }
      const plan = planHostedConflict(touched, base, current, stored);
      const choices =
        plan.pointers.length === 0 ? {} : await askHostedConflict(plan);
      // A block one side deleted, kept as the draft holds it: the change is
      // one move or delete, so none of it is written (a move's other half
      // alone would copy the block instead of moving it).
      const deleted = deletedBlockQuestion(plan);
      if (deleted && choices[deleted.pointer] === "theirs") {
        throw new HostedKeptTheirsError(
          deleted.conflict.kind === "theyDeleted",
        );
      }
      const resolved =
        plan.pointers.length === 0
          ? plan.merged
          : resolveFormConflict(plan, choices);
      const next = hostedChangeFromResolved(touched, resolved, stored);
      if (changeKeepsStored(next, stored)) {
        // The draft already is what the user wants: a deletion it already
        // holds, or their version kept.
        if (choseTheirs(choices)) {
          throw new HostedKeptTheirsError(
            touched.some((key) => !Object.hasOwn(stored, key)),
          );
        }
        return {
          revision: "",
          versions: {},
          change: next,
        };
      }
      current = next;
      base = Object.fromEntries(
        touched
          .filter((key) => Object.hasOwn(stored, key))
          .map((key) => [key, stored[key]]),
      );
    }
  }
}

/** Puts `blockKeys` in the decofile cache as `next` says (null: absent). */
function setCachedBlocks(
  ctx: HostedWriteContext,
  blockKeys: readonly string[],
  next: (key: string) => { value: unknown } | null,
) {
  ctx.queryClient.setQueryData<Record<string, unknown>>(
    KEYS.decofile(ctx.cacheKey),
    (current) => {
      if (!current) return current;
      const blocks = { ...current };
      for (const key of blockKeys) {
        const entry = next(key);
        if (entry) blocks[key] = entry.value;
        else delete blocks[key];
      }
      return blocks;
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
