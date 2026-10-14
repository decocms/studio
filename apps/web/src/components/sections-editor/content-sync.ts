/**
 * Every content change in the editor goes through here: an edit, a delete or
 * move, a discard (one or all), a publish, a release made current, and a
 * change someone else made (the content poll found a new revision).
 *
 * {@link runContentChange} runs the write and then the ONE refresh every
 * change shares ({@link contentChanged}): the editor's blocks, the draft
 * pointer (a new pointer reloads the preview), the header's publish status,
 * the publish dialog's change list and, after a publish or a reapply, the
 * releases. The open section form re-reads its block when someone other than
 * its own autosave changed it (the store's `epoch`).
 *
 * It also owns the pending state both indicators show, the preview's progress
 * bar and the header's "Saving…": `saving` while a write and its refresh run
 * (`inFlight` counts them), `reloading` until the hosted preview has loaded
 * the new content, then `idle`. A failed write goes back to `idle` at once and
 * rethrows to the caller's own error UI.
 *
 * One store per project (org + project), not per draft: a publish ends on a
 * new draft, and its reload is still the publish's.
 *
 * A discard ({@link runContentDiscard}) runs in the editor's own write queue:
 * the autosaves armed for the discarded blocks are dropped, and the discard
 * waits for the writes already queued or in flight, so it lands last. On a v8
 * site it removes those blocks from the draft (the draft is a sparse map of
 * changed blocks over main, layered over main's current version when read),
 * so the editor and the preview show main as it is then, and as it moves.
 */

import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { useMinimumDuration } from "@/hooks/use-minimum-duration";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import { decofileWriteMutationKey, decofileWriteScope } from "./decofile-api";
import { sandboxGitStatusQueryPrefix } from "../thread/repository/sandbox-git-api";
import { cmsPublishBodiesQueryPrefix } from "../thread/repository/use-cms-publish-state";

export type ContentChangeKind =
  | "edit"
  | "discard"
  | "publish"
  | "reapply"
  | "external";

export type ContentSyncPhase = "idle" | "saving" | "reloading";

export interface ContentSyncState {
  phase: ContentSyncPhase;
  /** Writes (with their refresh) still running. */
  inFlight: number;
  /**
   * Bumped when a `reloading` phase starts. `navigates`: the refresh moved
   * the draft pointer, so the preview navigates on its own; otherwise the
   * preview reloads the page it shows.
   */
  reload: { seq: number; navigates: boolean };
  /**
   * Bumped after a change the open form didn't make (discard, publish,
   * reapply, someone else's change): the form re-reads its block.
   */
  epoch: number;
}

const IDLE: ContentSyncState = {
  phase: "idle",
  inFlight: 0,
  reload: { seq: 0, navigates: false },
  epoch: 0,
};

/** How long `reloading` may wait for the preview before giving up. */
const PREVIEW_RELOAD_TIMEOUT_MS = 15_000;

interface Store {
  state: ContentSyncState;
  listeners: Set<() => void>;
  /** Mounted previews that confirm a reload (hosted v8 frames). */
  previews: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Editors' armed autosaves, dropped for the blocks a discard reverts. */
  discardListeners: Set<DiscardListener>;
}

/** Drops the caller's armed (not yet sent) autosaves of these blocks. */
export type DiscardListener = (blockKeys: ReadonlySet<string>) => void;

const stores = new Map<string, Store>();

export function contentSyncScope(orgSlug: string, virtualMcpId: string) {
  return `${orgSlug}/${virtualMcpId}`;
}

function storeOf(scope: string): Store {
  let store = stores.get(scope);
  if (!store) {
    store = {
      state: IDLE,
      listeners: new Set(),
      previews: 0,
      timer: null,
      discardListeners: new Set(),
    };
    stores.set(scope, store);
  }
  return store;
}

function set(scope: string, next: Partial<ContentSyncState>) {
  const store = storeOf(scope);
  store.state = { ...store.state, ...next };
  for (const listener of store.listeners) listener();
}

function clearTimer(store: Store) {
  if (store.timer) clearTimeout(store.timer);
  store.timer = null;
}

export function getContentSyncState(scope: string): ContentSyncState {
  return stores.get(scope)?.state ?? IDLE;
}

function subscribeContentSync(scope: string, listener: () => void) {
  const store = storeOf(scope);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** Test seam: forget every project's state. */
export function resetContentSync() {
  for (const store of stores.values()) clearTimer(store);
  stores.clear();
}

/**
 * A preview that reports its reloads. While none is mounted a change ends at
 * `idle` right after its refresh, with nothing to wait for.
 */
export function registerContentPreview(scope: string): () => void {
  const store = storeOf(scope);
  store.previews++;
  return () => {
    store.previews--;
    if (store.previews === 0 && store.state.phase === "reloading") {
      clearTimer(store);
      set(scope, { phase: "idle" });
    }
  };
}

/** The preview loaded: a `reloading` change is done. */
export function confirmPreviewReloaded(scope: string) {
  const store = stores.get(scope);
  if (!store || store.state.phase !== "reloading") return;
  clearTimer(store);
  set(scope, { phase: "idle" });
}

function begin(scope: string) {
  const store = storeOf(scope);
  clearTimer(store);
  set(scope, { phase: "saving", inFlight: store.state.inFlight + 1 });
}

/** A write and its refresh ended; the last one hands over to the preview. */
function end(scope: string, outcome: { ok: boolean; navigates: boolean }) {
  const store = storeOf(scope);
  const inFlight = Math.max(0, store.state.inFlight - 1);
  if (inFlight > 0) {
    set(scope, { inFlight });
    return;
  }
  if (!outcome.ok || store.previews === 0) {
    set(scope, { phase: "idle", inFlight });
    return;
  }
  awaitPreview(scope, outcome.navigates, inFlight);
}

function awaitPreview(scope: string, navigates: boolean, inFlight = 0) {
  const store = storeOf(scope);
  clearTimer(store);
  store.timer = setTimeout(() => {
    store.timer = null;
    if (store.state.phase === "reloading") set(scope, { phase: "idle" });
  }, PREVIEW_RELOAD_TIMEOUT_MS);
  set(scope, {
    phase: "reloading",
    inFlight,
    reload: { seq: store.state.reload.seq + 1, navigates },
  });
}

/** Who a change is for. `backend` decides what the refresh re-reads. */
export interface ContentSyncTarget {
  queryClient: QueryClient;
  orgSlug: string;
  virtualMcpId: string;
  /** The draft (branch) the editor shows; null when unknown. */
  branch: string | null;
  backend: ContentBackend | null;
  /** The editor's decofile cache key; null when unknown. */
  cacheKey: string | null;
}

export interface ContentChange {
  kind: ContentChangeKind;
  /** Re-read the blocks: the write changed them (not the form's own save). */
  reread?: boolean;
}

type ContentWrite<T> = ContentChange & {
  write: () => Promise<T>;
  refreshOnError?: boolean;
};

function isHosted(backend: ContentBackend | null): boolean {
  return backend?.kind === "protocol" && backend.source === "github";
}

/**
 * The ONE refresh after a content change. Resolves with whether the draft
 * pointer moved (the preview then navigates to it on its own).
 */
async function contentChanged(
  target: ContentSyncTarget,
  change: ContentChange,
): Promise<{ navigates: boolean }> {
  const { queryClient, orgSlug, virtualMcpId, branch, backend, cacheKey } =
    target;
  // Publish and reapply are hosted-only writes: the latest version moved.
  const releases =
    change.kind === "publish" || change.kind === "reapply"
      ? queryClient.invalidateQueries({
          queryKey: KEYS.hostedReleases(orgSlug, virtualMcpId),
        })
      : null;
  // Any other backend refreshes the way it always has, in its own write.
  if (backend?.kind !== "protocol") {
    await releases;
    return { navigates: false };
  }
  const pointerKey = branch
    ? KEYS.protocolDraftRead(orgSlug, virtualMcpId, branch)
    : null;
  const pointerBefore = pointerKey
    ? JSON.stringify(queryClient.getQueryData(pointerKey) ?? null)
    : null;
  const work: Promise<unknown>[] = releases ? [releases] : [];
  if (cacheKey && change.reread) {
    work.push(
      queryClient.invalidateQueries({ queryKey: KEYS.decofile(cacheKey) }),
    );
  }
  if (branch) {
    // The header's publish status and the dialog's change list.
    work.push(
      queryClient.invalidateQueries({
        queryKey: sandboxGitStatusQueryPrefix(orgSlug, virtualMcpId, branch),
      }),
    );
  }
  if (isHosted(backend)) {
    if (pointerKey) {
      work.push(queryClient.invalidateQueries({ queryKey: pointerKey }));
    }
    work.push(
      queryClient.invalidateQueries({
        queryKey: cmsPublishBodiesQueryPrefix(orgSlug, virtualMcpId),
      }),
    );
  }
  await Promise.all(work);
  if (change.kind !== "edit") {
    const scope = contentSyncScope(orgSlug, virtualMcpId);
    set(scope, { epoch: getContentSyncState(scope).epoch + 1 });
  }
  const pointerAfter = pointerKey
    ? JSON.stringify(queryClient.getQueryData(pointerKey) ?? null)
    : null;
  const navigates = pointerBefore !== pointerAfter;
  // The moved pointer is in the cache, but react-query tells its observers on
  // its own (deferred) schedule: wait for that, so the preview has rendered
  // the new frame URL before `reloading` asks it whether a load is under way.
  // Otherwise it would see the old, loaded URL and end the change at once.
  if (navigates) await new Promise<void>((r) => notifyManager.schedule(r));
  return { navigates };
}

/**
 * Runs one content write, then {@link contentChanged}, driving the pending
 * state throughout. A failed write ends the pending state at once and
 * rethrows; with `refreshOnError` the refresh still runs (in the background),
 * for writes that may have done part of their work (a publish).
 */
export async function runContentChange<T>(
  target: ContentSyncTarget,
  change: ContentWrite<T>,
): Promise<T> {
  begin(contentSyncScope(target.orgSlug, target.virtualMcpId));
  return runBegun(target, change);
}

/** {@link runContentChange} once its pending state has begun. */
async function runBegun<T>(
  target: ContentSyncTarget,
  change: ContentWrite<T>,
): Promise<T> {
  const scope = contentSyncScope(target.orgSlug, target.virtualMcpId);
  let result: T;
  try {
    result = await change.write();
  } catch (error) {
    end(scope, { ok: false, navigates: false });
    if (change.refreshOnError) {
      void contentChanged(target, { kind: change.kind, reread: true }).catch(
        () => {},
      );
    }
    throw error;
  }
  let navigates = false;
  try {
    ({ navigates } = await contentChanged(target, change));
  } catch {
    // The write landed; a failed re-read only leaves a list stale.
  } finally {
    // Only a hosted preview confirms reloads (it registers itself).
    end(scope, { ok: true, navigates });
  }
  return result;
}

/**
 * A discard of `blockKeys`, in the same write queue as the editor's saves
 * (`decofileWriteScope`: one write of a draft at a time, in order). First the
 * editors drop their armed autosaves of those blocks, which would otherwise
 * fire after the discard and bring the edit back; then the discard waits for
 * the writes already queued or in flight, and runs as a content change. So
 * the last write to land is the discard's: `write` removes the blocks from
 * the draft after every earlier save of them, and the refresh re-reads the
 * blocks (main's version now shows through), the draft pointer (the preview
 * reloads), the publish status and the change list; the open form re-reads
 * its block.
 */
export function runContentDiscard<T>(
  target: ContentSyncTarget,
  change: {
    blockKeys: readonly string[];
    write: () => Promise<T>;
  },
): Promise<T> {
  const { queryClient, orgSlug, virtualMcpId, branch } = target;
  const scope = contentSyncScope(orgSlug, virtualMcpId);
  const keys: ReadonlySet<string> = new Set(change.blockKeys);
  for (const listener of [...storeOf(scope).discardListeners]) listener(keys);
  // Pending from the click, while it waits its turn too.
  begin(scope);
  let started = false;
  const run = () => {
    started = true;
    return runBegun(target, {
      kind: "discard",
      reread: true,
      write: change.write,
    });
  };
  if (!branch) return run();
  return queryClient
    .getMutationCache()
    .build<T, Error, void, unknown>(queryClient, {
      mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
      scope: decofileWriteScope(orgSlug, virtualMcpId, branch),
      mutationFn: run,
    })
    .execute(undefined)
    .catch((error: unknown) => {
      if (!started) end(scope, { ok: false, navigates: false });
      throw error;
    });
}

/**
 * Registers an editor's armed autosaves with {@link runContentDiscard}. The
 * listener is read once (at mount): it must read refs, not render values.
 */
export function useContentDiscardListener(
  orgSlug: string,
  virtualMcpId: string,
  listener: DiscardListener,
) {
  const scope = contentSyncScope(orgSlug, virtualMcpId);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- subscribes to an external store for the component's lifetime
  useEffect(() => {
    const listeners = storeOf(scope).discardListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the listener reads refs only (see above)
  }, [scope]);
}

/**
 * Someone else changed the content (the poll found a new revision). Skipped
 * while this editor's own writes run: their refresh covers it.
 */
export function externalContentChange(target: ContentSyncTarget) {
  const scope = contentSyncScope(target.orgSlug, target.virtualMcpId);
  if (getContentSyncState(scope).inFlight > 0) return;
  void contentChanged(target, { kind: "external" })
    .then(({ navigates }) => {
      const store = storeOf(scope);
      if (store.previews > 0 && store.state.inFlight === 0) {
        awaitPreview(scope, navigates);
      }
    })
    .catch(() => {});
}

export function useContentSyncState(
  orgSlug: string,
  virtualMcpId: string,
): ContentSyncState {
  const scope = contentSyncScope(orgSlug, virtualMcpId);
  const subscribe = (listener: () => void) =>
    subscribeContentSync(scope, listener);
  const read = () => getContentSyncState(scope);
  return useSyncExternalStore(subscribe, read, read);
}

/** Floor for how long an indicator stays up, so a fast change can't flash. */
const INDICATOR_MIN_MS = 500;

/**
 * True while a content change is saving or its preview is reloading: what the
 * preview's progress bar and the header's "Saving…" both show.
 */
export function useContentSyncBusy(
  orgSlug: string,
  virtualMcpId: string,
): boolean {
  const { phase } = useContentSyncState(orgSlug, virtualMcpId);
  return useMinimumDuration(phase !== "idle", INDICATOR_MIN_MS);
}
