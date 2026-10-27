/**
 * An editor that keeps its own copy of a block (a global section's form,
 * a loader's, the page JSON, an app's settings…) saves that whole copy on
 * every keystroke. On a hosted v8 draft each save is guarded by a version,
 * and the version must be the one of the copy the editor shows, not the
 * draft's newest: a poll that read someone else's change would otherwise
 * let the next keystroke write the old copy over it, unasked.
 *
 * {@link HeldCopies} is that bookkeeping for one save hook (`useSaveBlock`
 * with `holdsCopy`): each block's copy as the editor loaded it (the cache
 * when the hook mounted, which is when an editor keyed by its block seeds
 * its form), moved by the editor's own confirmed saves, and replaced when
 * the editor shows the draft's copy again (it reseeded, or a reconcile
 * ended on something else than its own value). The guard is computed from
 * the copy itself ({@link heldCopyVersion}, the server's own content hash),
 * never paired with a version read separately.
 *
 * Each replacement starts a new generation: an edit takes the generation it
 * was made in ({@link HeldCopies.edited}), and an edit made before a
 * replacement (a keystroke still pending in the old form) is guarded by the
 * copy it was made on, so it is refused and reconciled, never written over
 * the result.
 */

import { useSyncExternalStore } from "react";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import type { DraftCopies } from "./content-protocol-api";
import { draftVersionOf } from "./draft-version";

/** A block's copy as an editor shows it. */
export interface HeldCopy {
  /** The copy; undefined when the editor holds none of it. */
  value: unknown;
  /**
   * Whether the draft held this copy when the editor took it. False: the
   * copy is main's, guarded "must not exist in the draft" (`null`).
   */
  inDraft: boolean;
}

/**
 * The `ifMatch` of a save built on `copy`: the draft's version of exactly
 * that copy (its content hash), `null` for main's copy, the tombstone's for
 * a block the draft deleted before the editor held any copy of it.
 */
export async function heldCopyVersion(copy: HeldCopy): Promise<string | null> {
  if (!copy.inDraft) return null;
  if (copy.value === undefined) return DRAFT_TOMBSTONE_VERSION;
  return draftVersionOf(copy.value);
}

/** The copy an edit was made on: see {@link HeldCopies.edited}. */
export interface HeldEdit {
  generation: number;
  copy: HeldCopy | undefined;
}

export class HeldCopies {
  private readonly copies = new Map<string, HeldCopy>();
  private readonly generations = new Map<string, number>();
  private loaded: DraftCopies | null;

  constructor(private readonly now: () => DraftCopies | null) {
    this.loaded = now();
  }

  /**
   * Takes the draft's copies when the hook mounted before they were read
   * (the editor seeds its form once they are). Called on each render.
   */
  settle(): void {
    if (!this.loaded) this.loaded = this.now();
  }

  /** The copy of `blockKey` the editor shows; undefined while unknown. */
  get(blockKey: string): HeldCopy | undefined {
    const own = this.copies.get(blockKey);
    if (own) return own;
    if (!this.loaded) return undefined;
    return {
      value: this.loaded.blocks[blockKey],
      inDraft: this.loaded.versionOf(blockKey) !== null,
    };
  }

  /** How many times `blockKey`'s copy was replaced under the editor. */
  generation(blockKey: string): number {
    return this.generations.get(blockKey) ?? 0;
  }

  /** The copy an edit of `blockKey` made now is built on. */
  edited(blockKey: string): HeldEdit {
    return { generation: this.generation(blockKey), copy: this.get(blockKey) };
  }

  /**
   * The copy a save of an edit guards by: the editor's current copy, unless
   * it was replaced after the edit was made (then the copy the edit was
   * made on, so the save is refused and reconciled).
   */
  guardOf(blockKey: string, edit: HeldEdit | undefined): HeldCopy | undefined {
    if (edit && edit.generation !== this.generation(blockKey)) return edit.copy;
    return this.get(blockKey);
  }

  /**
   * The editor shows the draft's copy of `blockKey` as the cache holds it
   * now (it opened another block, reseeded its form, or a reconcile ended
   * on the draft's copy or a merge): a new generation.
   */
  hold(blockKey: string): void {
    this.generations.set(blockKey, this.generation(blockKey) + 1);
    const now = this.now();
    // A block the draft deletes is never adopted: typing into a form left
    // on it is refused and asked about, never a silent comeback.
    if (!now || !Object.hasOwn(now.blocks, blockKey)) return;
    this.copies.set(blockKey, {
      value: now.blocks[blockKey],
      inDraft: now.versionOf(blockKey) !== null,
    });
  }

  /** The editor's own save of `value` landed in the draft. */
  saved(blockKey: string, value: unknown): void {
    this.copies.set(blockKey, { value, inDraft: true });
  }
}

/**
 * How many times each block's copy was replaced under its editors (per
 * editor scope: org, project and branch). An editor that keeps its own
 * copy keys its form by it, so it remounts from the draft's copy. Each
 * scope's map is replaced, never changed, so a reader handed out keeps its
 * answers and a new one is handed out after each bump.
 */
const epochs = new Map<string, ReadonlyMap<string, number>>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlyMap<string, number> = new Map();

/** The scope of {@link bumpCopyEpoch} / {@link useCopyEpochs}. */
export function copyScope(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): string {
  return `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`;
}

/** Tells `blockKey`'s editors in `scope` to show the draft's copy again. */
export function bumpCopyEpoch(scope: string, blockKey: string): void {
  const blocks = new Map(epochs.get(scope) ?? EMPTY);
  blocks.set(blockKey, (blocks.get(blockKey) ?? 0) + 1);
  epochs.set(scope, blocks);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readers = new WeakMap<
  ReadonlyMap<string, number>,
  (blockKey: string) => number
>();

/** One reader per snapshot: stable until the next bump, new after it. */
function readerOf(
  snapshot: ReadonlyMap<string, number>,
): (blockKey: string) => number {
  let reader = readers.get(snapshot);
  if (!reader) {
    reader = (blockKey) => snapshot.get(blockKey) ?? 0;
    readers.set(snapshot, reader);
  }
  return reader;
}

/**
 * Each block's copy epoch in `scope` (see {@link bumpCopyEpoch}): an editor
 * that keeps its own copy puts it in its form's key. The reader changes
 * with each bump, so a render memoized on it (the React Compiler) reads the
 * new epoch.
 */
export function useCopyEpochs(scope: string): (blockKey: string) => number {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => epochs.get(scope) ?? EMPTY,
    () => epochs.get(scope) ?? EMPTY,
  );
  return readerOf(snapshot);
}
