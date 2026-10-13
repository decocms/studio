/**
 * Every content change in the editor goes through here: an edit, a delete or
 * move, a discard (one or all), a publish, a release made current, and a
 * change someone else made (the content poll found a new revision).
 *
 * {@link runContentChange} runs the write and then the ONE refresh every
 * change shares ({@link contentChanged}): the editor's blocks, the draft
 * pointer (a new pointer reloads the preview), the header's publish status,
 * the publish dialog's change list and, after a publish or rollback, the
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
 */

import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useMinimumDuration } from "@/hooks/use-minimum-duration";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import type { DecofilePatchBody } from "./decofile-api";
import { sandboxGitStatusQueryPrefix } from "../thread/repository/sandbox-git-api";
import { cmsPublishBodiesQueryPrefix } from "../thread/repository/use-cms-publish-state";

export type ContentChangeKind =
  | "edit"
  | "discard"
  | "publish"
  | "rollback"
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
   * rollback, someone else's change): the form re-reads its block.
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
}

const stores = new Map<string, Store>();

export function contentSyncScope(orgSlug: string, virtualMcpId: string) {
  return `${orgSlug}/${virtualMcpId}`;
}

function storeOf(scope: string): Store {
  let store = stores.get(scope);
  if (!store) {
    store = { state: IDLE, listeners: new Set(), previews: 0, timer: null };
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
  /** What the write set and deleted: applied to the editor's blocks. */
  patch?: DecofilePatchBody;
  /** Re-read the blocks: the write changed them in ways `patch` can't say. */
  reread?: boolean;
}

function isHosted(backend: ContentBackend | null): boolean {
  return backend?.kind === "protocol" && backend.source === "github";
}

function applyPatch(
  current: Record<string, unknown> | undefined,
  patch: DecofilePatchBody,
): Record<string, unknown> | undefined {
  if (!current) return current;
  const next = { ...current, ...(patch.set ?? {}) };
  for (const key of patch.delete ?? []) {
    if (!(key in (patch.set ?? {}))) delete next[key];
  }
  return next;
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
  // Publish and rollback are hosted-only writes: what is live moved.
  const releases =
    change.kind === "publish" || change.kind === "rollback"
      ? queryClient.invalidateQueries({
          queryKey: KEYS.hostedReleases(orgSlug, virtualMcpId),
        })
      : null;
  // Any other backend refreshes the way it always has, in its own write.
  if (backend?.kind !== "protocol") {
    await releases;
    return { navigates: false };
  }
  if (cacheKey && change.patch) {
    queryClient.setQueryData<Record<string, unknown>>(
      KEYS.decofile(cacheKey),
      (current) => applyPatch(current, change.patch!),
    );
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
  change: ContentChange & {
    write: () => Promise<T>;
    refreshOnError?: boolean;
  },
): Promise<T> {
  const scope = contentSyncScope(target.orgSlug, target.virtualMcpId);
  begin(scope);
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
