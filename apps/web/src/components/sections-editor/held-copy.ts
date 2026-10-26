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
 * and the draft's versions when the hook mounted, which is when an editor
 * keyed by its block seeds its form), moved only by the editor's own
 * confirmed saves. A save the reconcile flow ended on anything else than
 * the editor's own value (their version, their deletion, a merge) leaves
 * it where it was, and tells the editor to show the draft's copy again
 * ({@link bumpCopyEpoch}): the editor remounts from it, and a keystroke
 * still pending in the old form is refused and reconciled, never written
 * over the result.
 */

import { useSyncExternalStore } from "react";
import type { DraftCopies } from "./content-protocol-api";

/** A block's copy as an editor shows it, and its version in the draft. */
export interface HeldCopy {
  value: unknown;
  version: string | null;
}

export class HeldCopies {
  private readonly copies = new Map<string, HeldCopy>();
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
      version: this.loaded.versionOf(blockKey),
    };
  }

  /**
   * The editor (re)seeded its form from the draft's copy of `blockKey` as
   * the cache holds it now (it opened another block, or showed the result
   * of a reconcile).
   */
  hold(blockKey: string): void {
    const now = this.now();
    // A block the draft deletes is never adopted: typing into a form left
    // on it is refused and asked about, never a silent comeback.
    if (!now || !Object.hasOwn(now.blocks, blockKey)) return;
    this.copies.set(blockKey, {
      value: now.blocks[blockKey],
      version: now.versionOf(blockKey),
    });
  }

  /** The editor's own save of `value` landed at `version`. */
  saved(blockKey: string, value: unknown, version: string | null): void {
    this.copies.set(blockKey, { value, version });
  }
}

/**
 * How many times each block's copy was replaced under its editors (per
 * editor scope: org, project and branch). An editor that keeps its own
 * copy keys its form by it, so it remounts from the draft's copy.
 */
const epochs = new Map<string, Map<string, number>>();
const scopeVersions = new Map<string, number>();
const listeners = new Set<() => void>();

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
  const blocks = epochs.get(scope) ?? new Map<string, number>();
  blocks.set(blockKey, (blocks.get(blockKey) ?? 0) + 1);
  epochs.set(scope, blocks);
  scopeVersions.set(scope, (scopeVersions.get(scope) ?? 0) + 1);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Each block's copy epoch in `scope` (see {@link bumpCopyEpoch}): an editor
 * that keeps its own copy puts it in its form's key.
 */
export function useCopyEpochs(scope: string): (blockKey: string) => number {
  useSyncExternalStore(
    subscribe,
    () => scopeVersions.get(scope) ?? 0,
    () => scopeVersions.get(scope) ?? 0,
  );
  return (blockKey) => epochs.get(scope)?.get(blockKey) ?? 0;
}
