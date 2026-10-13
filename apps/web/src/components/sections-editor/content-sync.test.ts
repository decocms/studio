import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
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
import {
  confirmPreviewReloaded,
  contentSyncScope,
  getContentSyncState,
  registerContentPreview,
  resetContentSync,
  runContentChange,
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
    batch: async (calls: BatchCall[]) =>
      calls.map(
        (call): BatchOutcome =>
          call.method === "blocks.list"
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
  const reads = { pointer: 0, status: 0, bodies: 0, releases: 0 };
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
  watch(["cms-publish-bodies", ORG, VM, BRANCH, "main", null, null], () => {
    reads.bodies++;
    return {};
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
  it("an edit is saving while it writes, reloading until the preview loads, then idle", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const { pointer } = editorQueries(queryClient);
    await settle();
    registerContentPreview(SCOPE);
    const gate = deferred<void>();
    state.gate = gate.promise;
    pointer.version = "e2";

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
    confirmPreviewReloaded(SCOPE);
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
    // The form made this change: it doesn't re-read its block.
    expect(getContentSyncState(SCOPE).epoch).toBe(0);
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
  it("a hosted discard writes through blocks.apply and refreshes the blocks, pointer, status and change list", async () => {
    const queryClient = new QueryClient();
    const { state, backend } = fakeBackend();
    const { pointer, reads } = editorQueries(queryClient);
    await settle();
    const before = { ...reads };
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      Home: { title: "edited" },
      Promo: { title: "draft only" },
    });
    pointer.version = "e3";

    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      CACHE_KEY,
      { set: { Home: { title: "main" } }, delete: ["Promo"] },
      undefined,
      "discard",
    );

    expect(state.applied).toEqual([
      { set: { Home: { title: "main" } }, delete: ["Promo"] },
    ]);
    expect(
      queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(CACHE_KEY),
      ),
    ).toEqual({
      Home: { title: "main" },
    });
    expect(reads.pointer).toBe(before.pointer + 1);
    expect(reads.status).toBe(before.status + 1);
    expect(reads.bodies).toBe(before.bodies + 1);
    expect(reads.releases).toBe(before.releases);
    // The open form re-reads the block it shows.
    expect(getContentSyncState(SCOPE).epoch).toBe(1);
  });

  it("a publish or rollback re-reads the releases and the blocks", async () => {
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
    for (const kind of ["publish", "rollback"] as const) {
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
      kind: "rollback",
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
    expect(reads.status).toBe(before.status + 1);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      epoch: 1,
      reload: { navigates: true },
    });
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
});
