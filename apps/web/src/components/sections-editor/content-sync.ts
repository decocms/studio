/**
 * Every content change in the editor goes through here: an edit, a delete or
 * move, a discard (one or all), a publish, a release made current, and a
 * change someone else made (the content poll found a new revision).
 *
 * {@link runContentChange} runs the write and then the ONE refresh every
 * change shares ({@link contentChanged}): the editor's blocks, the draft
 * pointer (a new pointer reloads the preview), the changes against the base
 * (`changes.list`: the header's count, the publish dialog's and Localhost's
 * change lists) and, after a publish or a reapply, the releases. The open section form re-reads its block when someone other than
 * its own autosave changed it (the store's `epoch`).
 *
 * A hosted save (Studio's draft) is the exception: its answer already moved
 * the draft pointer and the changes list (content-protocol-api.ts
 * `adoptHostedSave`), so it reads neither and ends as soon as the server
 * confirms it (`adopted`).
 *
 * It also owns the pending state both indicators show, the preview's progress
 * bar and the header's "Saving…": `saving` while a write and its refresh run
 * (`inFlight` counts them), `reloading` until the hosted preview has loaded
 * the new content, then `idle`. A failed write goes back to `idle` at once and
 * rethrows to the caller's own error UI.
 *
 * One store per project (org + project), not per draft: a publish ends on a
 * new version of the same draft (emptied, same pointer address), and its
 * reload is still the publish's.
 *
 * A discard ({@link runContentDiscard}) runs in the editor's own write queue:
 * the autosaves armed for the discarded blocks are dropped, and the discard
 * waits for the writes already queued or in flight, so it lands last. On a v8
 * site it drops those blocks back to the source's base (`changes.discard`:
 * main on GitHub, the last commit in a sandbox or on Localhost), so the
 * editor and the preview show the base as it is then.
 */

import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { useMinimumDuration } from "@/hooks/use-minimum-duration";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend } from "./content-backend";
import { announceContentWrite } from "./content-writes-channel";
import { decofileWriteMutationKey, decofileWriteScope } from "./decofile-api";
import { sandboxGitStatusQueryPrefix } from "../thread/repository/sandbox-git-api";

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
  /** Editors' armed autosaves, sent now by {@link settleContentEdits}. */
  flushListeners: Set<FlushListener>;
}

/** Drops the caller's armed (not yet sent) autosaves of these blocks. */
export type DiscardListener = (blockKeys: ReadonlySet<string>) => void;

/**
 * Sends the caller's armed autosaves now. True while it still holds a save
 * that isn't in the write queue yet (one waiting for the save on the wire).
 */
export type FlushListener = () => boolean;

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
      flushListeners: new Set(),
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
  /**
   * The write's answer already updated the changes and the draft pointer (a
   * hosted save, content-protocol-api.ts `adoptHostedSave`): the refresh
   * reads neither, and the change ends as soon as the write is confirmed.
   */
  adopted?: boolean;
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
  if (cacheKey && !change.adopted) {
    // The changes against the base and their sides: the header's count and
    // every change list.
    work.push(
      queryClient.invalidateQueries({
        queryKey: KEYS.contentChanges(cacheKey),
      }),
    );
  }
  if (branch && backend.source === "sandbox") {
    // A sandbox publishes with git: its coding header and the Publish step
    // read the branch's git status.
    work.push(
      queryClient.invalidateQueries({
        queryKey: sandboxGitStatusQueryPrefix(orgSlug, virtualMcpId, branch),
      }),
    );
  }
  if (isHosted(backend) && pointerKey && !change.adopted) {
    work.push(queryClient.invalidateQueries({ queryKey: pointerKey }));
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

/** The draft pointer the editor holds now (hosted), as a comparable string. */
function pointerNow(target: ContentSyncTarget): string | null {
  if (!target.branch) return null;
  return JSON.stringify(
    target.queryClient.getQueryData(
      KEYS.protocolDraftRead(
        target.orgSlug,
        target.virtualMcpId,
        target.branch,
      ),
    ) ?? null,
  );
}

/** {@link runContentChange} once its pending state has begun. */
async function runBegun<T>(
  target: ContentSyncTarget,
  change: ContentWrite<T>,
): Promise<T> {
  const scope = contentSyncScope(target.orgSlug, target.virtualMcpId);
  const pointerBefore = change.adopted ? pointerNow(target) : null;
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
  // The editor's other views on this draft read it again now.
  if (target.backend?.kind === "protocol" && target.cacheKey) {
    announceContentWrite(target.cacheKey);
  }
  if (change.adopted) {
    // Saved once the server confirmed: the answer moved the pointer and the
    // changes already; whatever else the change re-reads runs on its own,
    // outside the write queue.
    const navigates = pointerNow(target) !== pointerBefore;
    // As in `contentChanged`: the preview renders the new frame URL first.
    if (navigates) await new Promise<void>((r) => notifyManager.schedule(r));
    end(scope, { ok: true, navigates });
    if (change.reread) void contentChanged(target, change).catch(() => {});
    return result;
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
 * the last write to land is the discard's: `write` drops the blocks back to
 * the base after every earlier save of them, and the refresh re-reads the
 * blocks (the base's version now shows through), the draft pointer (the
 * preview reloads) and the changes; the open form re-reads its block.
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
 * Registers an editor's armed autosaves of project `project` with
 * {@link settleContentEdits}; none while it is null. The listener is read
 * once (at mount): it must read refs, not render values.
 */
export function useContentFlushListener(
  project: { orgSlug: string; virtualMcpId: string } | null,
  listener: FlushListener,
) {
  const scope = project
    ? contentSyncScope(project.orgSlug, project.virtualMcpId)
    : null;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- subscribes to an external store for the component's lifetime
  useEffect(() => {
    if (!scope) return;
    const listeners = storeOf(scope).flushListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the listener reads refs only (see above)
  }, [scope]);
}

/** The draft whose edits {@link settleContentEdits} waits for. */
export type ContentEditsTarget = Pick<
  ContentSyncTarget,
  "queryClient" | "orgSlug" | "virtualMcpId" | "branch"
>;

/** A write of the draft is queued, on the wire, or refreshing after it. */
function writesPending(target: ContentEditsTarget): boolean {
  const { queryClient, orgSlug, virtualMcpId, branch } = target;
  const scope = contentSyncScope(orgSlug, virtualMcpId);
  if (getContentSyncState(scope).inFlight > 0) return true;
  return (
    !!branch &&
    queryClient.isMutating({
      mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    }) > 0
  );
}

/**
 * Sends every editor's armed autosaves now. True while one of them, or a
 * write already sent, hasn't landed: {@link settleContentEdits} waits for it.
 */
export function flushContentEdits(target: ContentEditsTarget): boolean {
  const scope = contentSyncScope(target.orgSlug, target.virtualMcpId);
  let held = false;
  for (const listener of [...storeOf(scope).flushListeners]) {
    if (listener()) held = true;
  }
  return held || writesPending(target);
}

function writesSettled(target: ContentEditsTarget): Promise<void> {
  if (!writesPending(target)) return Promise.resolve();
  const scope = contentSyncScope(target.orgSlug, target.virtualMcpId);
  return new Promise((resolve) => {
    const check = () => {
      if (writesPending(target)) return;
      unsubscribeStore();
      unsubscribeMutations();
      resolve();
    };
    const unsubscribeStore = subscribeContentSync(scope, check);
    const unsubscribeMutations = target.queryClient
      .getMutationCache()
      .subscribe(check);
  });
}

/** Rounds of a save waiting for another before the caller goes ahead anyway. */
const SETTLE_ROUNDS = 5;

/**
 * Every edit made so far is in the draft: the armed autosaves are sent and
 * every write of the draft has landed (a hosted save's answer moved the
 * draft pointer and the changes). Read before anything that hands out the
 * draft's current version (Review & Publish, a preview link), or an edit
 * made just before would be missing from it. Never rejects: a failed save
 * already said so, and the caller goes on with what the draft holds.
 */
export async function settleContentEdits(
  target: ContentEditsTarget,
): Promise<void> {
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    if (!flushContentEdits(target)) return;
    await writesSettled(target);
  }
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
