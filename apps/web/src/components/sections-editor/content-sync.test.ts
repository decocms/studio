import { afterEach, describe, expect, it } from "bun:test";
import {
  notifyManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import type {
  BatchCall,
  BatchOutcome,
  ContentClient,
  DescribeResult,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import type { ContentBackend, ProtocolBackend } from "./content-backend";
import {
  applyProtocolPatch,
  pollProtocolContent,
} from "./content-protocol-api";
import { decofileWriteScope } from "./decofile-api";
import {
  confirmPreviewReloaded,
  contentSyncScope,
  getContentSyncState,
  registerContentPreview,
  resetContentSync,
  runContentChange,
  runContentDiscard,
  type ContentSyncTarget,
} from "./content-sync";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;
const SCOPE = contentSyncScope(ORG, VM);
const params = { orgSlug: ORG, virtualMcpId: VM, branch: BRANCH };

afterEach(() => resetContentSync());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BASE = { revision: "main-1", resolvedRef: "main" };

/** `changes.list`'s answer at a content revision. */
function changesOf(revision: string) {
  return {
    notModified: false as const,
    revision: `c-${revision}`,
    base: BASE,
    changes: {},
  };
}

/** A content server that records its writes; `revision` is what it lists. */
function fakeBackend(source: "github" | "sandbox" | "local" = "github") {
  const state = {
    revision: "r1",
    blocks: { Home: { title: "main" } } as Record<string, unknown>,
    applied: [] as unknown[],
    gate: null as Promise<void> | null,
  };
  const client = {
    blocksApply: async (patch: unknown) => {
      state.applied.push(patch);
      if (state.gate) await state.gate;
      state.revision = `r${state.applied.length + 1}`;
      return { revision: state.revision, versions: {} };
    },
    changesList: async () => changesOf(state.revision),
    batch: async (calls: BatchCall[]) =>
      calls.map(
        (call): BatchOutcome =>
          call.method === "changes.list"
            ? {
                ok: true,
                result:
                  (call.params as { ifNoneMatch?: string }).ifNoneMatch ===
                  `c-${state.revision}`
                    ? {
                        notModified: true,
                        revision: `c-${state.revision}`,
                        base: BASE,
                      }
                    : changesOf(state.revision),
              }
            : call.method === "blocks.list"
              ? {
                  ok: true,
                  result:
                    (call.params as { ifNoneMatch?: string }).ifNoneMatch ===
                    state.revision
                      ? { notModified: true, revision: state.revision }
                      : {
                          notModified: false,
                          revision: state.revision,
                          resolvedRef: null,
                          blocks: state.blocks,
                          versions: {},
                        },
                }
              : {
                  ok: true,
                  result: {
                    notModified: false,
                    version: null,
                    resolvedRef: null,
                    schema: null,
                  },
                },
      ),
  } as unknown as ContentClient;
  const backend: ProtocolBackend = {
    kind: "protocol",
    source,
    client,
    describe: {} as DescribeResult,
    cacheKeySuffix: "",
  };
  return { state, backend };
}

/** The editor's queries a change refreshes, mounted as the editor mounts them. */
function editorQueries(queryClient: QueryClient) {
  const pointer = { version: "e1" };
  const reads = { pointer: 0, status: 0, changes: 0, releases: 0 };
  const watch = (queryKey: readonly unknown[], queryFn: () => unknown) =>
    new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => queryFn(),
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
  watch(KEYS.protocolDraftRead(ORG, VM, BRANCH), () => {
    reads.pointer++;
    return { draft: "d", version: pointer.version };
  });
  // A session's status entry (its key carries the thread id).
  watch(["sandbox-git-status", ORG, VM, BRANCH, "thread-9"], () => {
    reads.status++;
    return {};
  });
  // The changes against the base (`changes.list`): the header's count and
  // every change list.
  watch(KEYS.contentChanges(CACHE_KEY), () => {
    reads.changes++;
    return changesOf("any");
  });
  watch(KEYS.hostedReleases(ORG, VM), () => {
    reads.releases++;
    return {};
  });
  return { pointer, reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function target(
  queryClient: QueryClient,
  backend: ContentBackend | null,
): ContentSyncTarget {
  return {
    queryClient,
    orgSlug: ORG,
    virtualMcpId: VM,
    branch: BRANCH,
    backend,
    cacheKey: CACHE_KEY,
  };
}

describe("content-sync pending state", () => {
  it("a hosted save is saving while it writes, reloading once confirmed (its answer moved the pointer, nothing read), then idle", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const { reads } = editorQueries(queryClient);
    await settle();
    registerContentPreview(SCOPE);
    const before = { ...reads };
    const gate = deferred<void>();
    // As Studio's hosted save answers: the draft's new ETag, no main part.
    backend.client.blocksApply = async (patch) => {
      state.applied.push(patch);
      await gate.promise;
      return { revision: "~e2", versions: { Home: "v2" } };
    };

    const saving = applyProtocolPatch(queryClient, backend, params, CACHE_KEY, {
      set: { Home: { title: "edited" } },
    });
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "saving",
      inFlight: 1,
    });
    gate.resolve();
    await saving;
    // The pointer moved: the preview navigates to it, and its load ends it.
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      inFlight: 0,
      reload: { seq: 1, navigates: true },
    });
    expect(
      queryClient.getQueryData(KEYS.protocolDraftRead(ORG, VM, BRANCH)),
    ).toMatchObject({ version: "e2" });
    // Nothing was read again: not the pointer, not the changes.
    await settle();
    expect(reads).toEqual(before);
    confirmPreviewReloaded(SCOPE);
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
    // The form made this change: it doesn't re-read its block.
    expect(getContentSyncState(SCOPE).epoch).toBe(0);
  });

  it("asks the preview to reload only after its observers saw the moved pointer", async () => {
    const queryClient = new QueryClient();
    const { backend } = fakeBackend();
    let seen = "e1";
    new QueryObserver(queryClient, {
      queryKey: KEYS.protocolDraftRead(ORG, VM, BRANCH),
      queryFn: async () => ({ draft: "d", version: "e1" }),
      staleTime: Number.POSITIVE_INFINITY,
      // What the preview renders its frame URL from: the pointer's observer,
      // subscribed the way `useQuery` subscribes (batched, deferred).
    }).subscribe(
      notifyManager.batchCalls((result) => {
        seen =
          (result.data as { version?: string } | undefined)?.version ?? seen;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    registerContentPreview(SCOPE);
    backend.client.blocksApply = async () => ({
      revision: "~e2",
      versions: {},
    });
    await applyProtocolPatch(queryClient, backend, params, CACHE_KEY, {
      set: { Home: { title: "edited" } },
    });
    // `reloading` was just set: the frame URL must already be the new one, or
    // the preview takes its old, loaded frame for the moved pointer's.
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      reload: { navigates: true },
    });
    expect(seen).toBe("e2");
  });

  it("a sandbox save still refreshes the changes before it ends", async () => {
    const queryClient = new QueryClient();
    const { backend } = fakeBackend("sandbox");
    const { reads } = editorQueries(queryClient);
    await settle();
    const before = { ...reads };
    await applyProtocolPatch(queryClient, backend, params, CACHE_KEY, {
      set: { Home: { title: "edited" } },
    });
    expect(reads.changes).toBe(before.changes + 1);
  });

  it("counts overlapping writes and hands over to the preview after the last", async () => {
    const queryClient = new QueryClient();
    registerContentPreview(SCOPE);
    const first = deferred<string>();
    const second = deferred<string>();
    const t = target(queryClient, fakeBackend().backend);
    const a = runContentChange(t, { kind: "edit", write: () => first.promise });
    const b = runContentChange(t, {
      kind: "edit",
      write: () => second.promise,
    });
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "saving",
      inFlight: 2,
    });
    first.resolve("a");
    await a;
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "saving",
      inFlight: 1,
    });
    second.resolve("b");
    await b;
    // Same pointer: the preview reloads the page it shows.
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      reload: { navigates: false },
    });
  });

  it("a failed write is idle at once and rethrows (no stuck Saving…)", async () => {
    const queryClient = new QueryClient();
    registerContentPreview(SCOPE);
    const failure = new Error("boom");
    await expect(
      runContentChange(target(queryClient, fakeBackend().backend), {
        kind: "discard",
        write: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
    });
  });

  it("without a preview to confirm, a change ends at idle after its refresh", async () => {
    const queryClient = new QueryClient();
    await runContentChange(target(queryClient, fakeBackend().backend), {
      kind: "edit",
      write: async () => "ok",
    });
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
  });

  it("a preview unmounting mid-reload ends the change", async () => {
    const queryClient = new QueryClient();
    const unregister = registerContentPreview(SCOPE);
    await runContentChange(target(queryClient, fakeBackend().backend), {
      kind: "edit",
      write: async () => "ok",
    });
    expect(getContentSyncState(SCOPE).phase).toBe("reloading");
    unregister();
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
  });
});

describe("content-sync refresh (contentChanged)", () => {
  it("a hosted discard removes the draft's entries and refreshes the blocks, pointer and changes (never git)", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const { pointer, reads } = editorQueries(queryClient);
    // The editor's blocks: the draft over main.
    state.blocks = {
      Home: { title: "edited" },
      Promo: { title: "draft only" },
    };
    new QueryObserver(queryClient, {
      queryKey: KEYS.decofile(CACHE_KEY),
      queryFn: async () => state.blocks,
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
    await settle();
    const before = { ...reads };

    await runContentDiscard(target(queryClient, backend), {
      blockKeys: ["Home", "Promo"],
      // The server drops the entries: main shows through; a new draft ETag.
      write: async () => {
        state.blocks = { Home: { title: "main" } };
        pointer.version = "e3";
      },
    });

    expect(state.applied).toEqual([]);
    expect(
      queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(CACHE_KEY),
      ),
    ).toEqual({ Home: { title: "main" } });
    expect(reads.pointer).toBe(before.pointer + 1);
    expect(reads.changes).toBe(before.changes + 1);
    // A hosted draft's changes are the protocol's: git's status isn't read.
    expect(reads.status).toBe(before.status);
    expect(reads.releases).toBe(before.releases);
    // The open form re-reads the block it shows.
    expect(getContentSyncState(SCOPE).epoch).toBe(1);
  });

  it("a discard waits for the editor's save in flight and lands after it", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const order: string[] = [];
    // The editor's autosave, as useSaveBlock runs it: in the draft's write
    // queue, still in flight (its blocks.apply hasn't answered).
    const gate = deferred<void>();
    state.gate = gate.promise;
    const save = queryClient
      .getMutationCache()
      .build(queryClient, {
        scope: decofileWriteScope(ORG, VM, BRANCH),
        mutationFn: async () => {
          await applyProtocolPatch(queryClient, backend, params, CACHE_KEY, {
            set: { Home: { title: "edited" } },
          });
          order.push("save");
        },
      })
      .execute(undefined);
    await settle();
    expect(state.applied).toHaveLength(1);

    const discard = runContentDiscard(target(queryClient, backend), {
      blockKeys: ["Home"],
      write: async () => {
        order.push("discard");
      },
    });
    await settle();
    // Queued behind the save: nothing discarded yet.
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([save, discard]);
    expect(order).toEqual(["save", "discard"]);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
      epoch: 1,
    });
  });

  it("a save made after a discard queues behind it (the newer edit wins)", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const order: string[] = [];
    const gate = deferred<void>();
    const discard = runContentDiscard(target(queryClient, backend), {
      blockKeys: ["Home"],
      write: async () => {
        await gate.promise;
        order.push("discard");
      },
    });
    await settle();
    const save = queryClient
      .getMutationCache()
      .build(queryClient, {
        scope: decofileWriteScope(ORG, VM, BRANCH),
        mutationFn: async () => {
          await applyProtocolPatch(queryClient, backend, params, CACHE_KEY, {
            set: { Home: { title: "after" } },
          });
          order.push("save");
        },
      })
      .execute(undefined);
    await settle();
    expect(state.applied).toEqual([]);
    gate.resolve();
    await Promise.all([discard, save]);
    expect(order).toEqual(["discard", "save"]);
    expect(state.applied).toEqual([{ set: { Home: { title: "after" } } }]);
  });

  it("a publish or reapply re-reads the releases and the blocks", async () => {
    const queryClient = new QueryClient();
    const { reads } = editorQueries(queryClient);
    await settle();
    const before = { ...reads };
    let blockReads = 0;
    new QueryObserver(queryClient, {
      queryKey: KEYS.decofile(CACHE_KEY),
      queryFn: async () => {
        blockReads++;
        return {};
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
    await settle();
    for (const kind of ["publish", "reapply"] as const) {
      await runContentChange(target(queryClient, fakeBackend().backend), {
        kind,
        reread: true,
        write: async () => "ok",
      });
    }
    expect(reads.releases).toBe(before.releases + 2);
    expect(reads.pointer).toBe(before.pointer + 2);
    expect(blockReads).toBe(3);
    expect(getContentSyncState(SCOPE).epoch).toBe(2);
  });

  it("a release made current refreshes the releases whatever the backend", async () => {
    const queryClient = new QueryClient();
    const { reads } = editorQueries(queryClient);
    await settle();
    const before = { ...reads };
    await runContentChange(target(queryClient, { kind: "pending" }), {
      kind: "reapply",
      write: async () => "ok",
    });
    expect(reads.releases).toBe(before.releases + 1);
    expect(reads.pointer).toBe(before.pointer);
  });

  it("a v7 (legacy) write only drives the pending state: its own write refreshes", async () => {
    const queryClient = new QueryClient();
    const { reads } = editorQueries(queryClient);
    await settle();
    const before = { ...reads };
    const gate = deferred<void>();
    const write = runContentChange(target(queryClient, { kind: "legacy" }), {
      kind: "discard",
      write: () => gate.promise,
    });
    expect(getContentSyncState(SCOPE).phase).toBe("saving");
    gate.resolve();
    await write;
    expect(reads).toEqual(before);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      epoch: 0,
    });
  });

  it("someone else's change (a moved revision on poll) refreshes the pointer and reloads the preview", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const { pointer, reads } = editorQueries(queryClient);
    await settle();
    registerContentPreview(SCOPE);
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const before = { ...reads };

    // Nothing moved: no refresh.
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await settle();
    expect(reads).toEqual(before);

    state.revision = "r-other";
    state.blocks = { Home: { title: "theirs" } };
    pointer.version = "e9";
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await settle();
    await settle();
    expect(reads.pointer).toBe(before.pointer + 1);
    expect(reads.changes).toBe(before.changes + 1);
    expect(reads.status).toBe(before.status);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      epoch: 1,
      reload: { navigates: true },
    });
  });

  it("the poll carries changes.list, conditional on its revision, and keeps the list current", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const sent: BatchCall[][] = [];
    const batch = backend.client.batch.bind(backend.client);
    backend.client.batch = async (calls) => {
      sent.push(calls);
      return batch(calls);
    };
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(sent[0]!.map((call) => call.method)).toEqual([
      "blocks.list",
      "schema.get",
      "changes.list",
    ]);
    expect(sent[0]![2]!.params).toEqual({});
    expect(
      queryClient.getQueryData(KEYS.contentChanges(CACHE_KEY)),
    ).toMatchObject({ revision: "c-r1", base: BASE });
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(sent[1]![2]!.params).toEqual({ ifNoneMatch: "c-r1" });
    state.revision = "r2";
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    expect(
      queryClient.getQueryData(KEYS.contentChanges(CACHE_KEY)),
    ).toMatchObject({ revision: "c-r2" });
  });

  it("a sandbox change also re-reads the branch's git status (its Publish is git)", async () => {
    const queryClient = new QueryClient();
    const { backend } = fakeBackend("sandbox");
    const { reads } = editorQueries(queryClient);
    await settle();
    const before = { ...reads };
    await runContentChange(target(queryClient, backend), {
      kind: "edit",
      write: async () => "ok",
    });
    expect(reads.changes).toBe(before.changes + 1);
    expect(reads.status).toBe(before.status + 1);
  });

  it("a poll during this editor's own write is not someone else's change", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    editorQueries(queryClient);
    await settle();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    const gate = deferred<void>();
    const write = runContentChange(target(queryClient, backend), {
      kind: "edit",
      write: () => gate.promise,
    });
    state.revision = "r-mine";
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await settle();
    expect(getContentSyncState(SCOPE).epoch).toBe(0);
    gate.resolve();
    await write;
  });

  it("a poll that listed before this editor's write and lands after it is not someone else's change", async () => {
    const queryClient = new QueryClient();
    const { backend } = fakeBackend();
    const { reads } = editorQueries(queryClient);
    await settle();
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    // The next poll lists now (before the write) but lands after it.
    const client = backend.client as { batch: ContentClient["batch"] };
    const listBatch = client.batch;
    const landed = deferred<void>();
    client.batch = async (calls) => {
      const outcome = await listBatch(calls);
      await landed.promise;
      return outcome;
    };
    const stalePoll = pollProtocolContent(
      queryClient,
      backend,
      params,
      CACHE_KEY,
    );
    client.batch = listBatch;
    await applyProtocolPatch(queryClient, backend, params, CACHE_KEY, {
      set: { Home: { title: "edited" } },
    });
    const afterWrite = { ...reads };
    landed.resolve();
    await stalePoll;
    // It kept the write's revision, so the next poll finds nothing new.
    expect(
      queryClient.getQueryData<{ revision?: string }>(
        KEYS.contentRevision(CACHE_KEY),
      )?.revision,
    ).toBe("r2");
    await pollProtocolContent(queryClient, backend, params, CACHE_KEY);
    await settle();
    await settle();
    expect(reads).toEqual(afterWrite);
    expect(getContentSyncState(SCOPE).epoch).toBe(0);
  });
});
