import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { toast } from "sonner";
import { act, renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  type ContentClient,
  ContentProtocolError,
  type DescribeResult,
  ErrorCode,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import type {
  ContentBackend,
  ProtocolBackend,
} from "@/components/sections-editor/content-backend";
import {
  confirmPreviewReloaded,
  contentSyncScope,
  getContentSyncState,
  registerContentPreview,
  resetContentSync,
  useContentDiscardListener,
  type ContentSyncTarget,
} from "@/components/sections-editor/content-sync";
import {
  applyProtocolPatch,
  pollProtocolContent,
} from "@/components/sections-editor/content-protocol-api";
import { decofileWriteScope } from "@/components/sections-editor/decofile-api";
import {
  blockKeyFromDiffPath,
  type PublishChange,
} from "./publish-change-summary";
import type { PublishTarget } from "./publish-flow";
import * as realGit from "./sandbox-git-api";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;
const SCOPE = contentSyncScope(ORG, VM);
const HOME = ".deco/blocks/pages-home.json";

/**
 * The hosted draft as the server keeps it: a sparse map of changed blocks over
 * main (`set`/`delete`), read layered over main's CURRENT blocks; each write
 * is a new draft object (a new ETag, so a new draft pointer). A put of main's
 * own value leaves no entry; `changes.discard` removes the entries (v7's
 * `/git/discard` is the git route).
 */
const server = {
  main: {} as Record<string, unknown>,
  draft: { set: {} as Record<string, unknown>, delete: [] as string[] },
  etag: 1,
  /** main's head: it moves when someone publishes. */
  head: 1,
  discards: [] as string[][],
  /** Every `changes.discard` call's params. */
  discardCalls: [] as Array<{
    names: string[];
    ifMatch?: Record<string, string | null>;
  }>,
  failDiscard: false,
  /** The entries moved since the list was read: a discard is a Conflict. */
  conflict: false,
  onDiscard: null as (() => void) | null,
};

function resetServer() {
  server.main = { "pages-home": { title: "main" } };
  server.draft = { set: {}, delete: [] };
  server.etag = 1;
  server.head = 1;
  server.discards = [];
  server.discardCalls = [];
  server.failDiscard = false;
  server.conflict = false;
  server.onDiscard = null;
}

const revision = () => `${server.head}~e${server.etag}`;

/** What the editor and the preview read: the draft over main as it is now. */
function layered(): Record<string, unknown> {
  const blocks = { ...server.main, ...server.draft.set };
  for (const key of server.draft.delete) delete blocks[key];
  return blocks;
}

async function discardFromDraft(_target: unknown, paths: string[]) {
  dropFromDraft(paths.flatMap((p) => blockKeyFromDiffPath(p) ?? []));
}

/** Drops entries from the draft: main shows through again. */
function dropFromDraft(names: string[]) {
  if (server.failDiscard) throw new Error("nope");
  server.onDiscard?.();
  const keys = new Set(names);
  server.discards.push([...keys]);
  server.draft = {
    set: Object.fromEntries(
      Object.entries(server.draft.set).filter(([key]) => !keys.has(key)),
    ),
    delete: server.draft.delete.filter((key) => !keys.has(key)),
  };
  server.etag++;
}
const discardGitFiles = mock(discardFromDraft);
const fetchGitDiff = mock(async (..._args: unknown[]) => ({ diffs: {} }));
mock.module("./sandbox-git-api", () => ({
  ...realGit,
  discardGitFiles,
  fetchGitDiff,
}));
// What the user is told: one toast per action (spied, restored after).
const toasts: Array<{ kind: string; message: string }> = [];
const toastSpies = (["success", "error", "info"] as const).map((kind) =>
  spyOn(toast, kind).mockImplementation(((message: unknown) => {
    toasts.push({ kind, message: String(message) });
    return 0;
  }) as never),
);
afterAll(() => {
  for (const spy of toastSpies) spy.mockRestore();
});
let currentTarget: ContentSyncTarget | null = null;
mock.module("@/components/sections-editor/use-content-sync", () => ({
  useContentSyncTarget: () => currentTarget,
}));

const { useCmsPublishActions } = await import("./use-cms-publish-actions");

function hostedBackend() {
  const applied: unknown[] = [];
  let gate: Promise<void> | null = null;
  const client = {
    blocksApply: async (patch: { set?: Record<string, unknown> }) => {
      applied.push(patch);
      if (gate) await gate;
      for (const [key, value] of Object.entries(patch.set ?? {})) {
        const sameAsMain =
          JSON.stringify(server.main[key]) === JSON.stringify(value);
        const { [key]: _, ...rest } = server.draft.set;
        server.draft.set = sameAsMain ? rest : { ...rest, [key]: value };
      }
      server.etag++;
      return { revision: revision(), versions: {} };
    },
    // The content poll: blocks.list (layered), schema.get, changes.list.
    batch: async (
      calls: Array<{ method: string; params?: { ifNoneMatch?: string } }>,
    ) =>
      calls.map((call) =>
        call.method === "blocks.list"
          ? {
              ok: true,
              // As the core answers: "not modified" for the revision seen.
              result:
                call.params?.ifNoneMatch === revision()
                  ? { notModified: true, revision: revision() }
                  : {
                      notModified: false,
                      revision: revision(),
                      resolvedRef: null,
                      blocks: layered(),
                      versions: {},
                    },
            }
          : call.method === "changes.list"
            ? { ok: true, result: changesList() }
            : {
                ok: true,
                result: { notModified: false, version: "s1", schema: {} },
              },
      ),
    changesList: async () => changesList(),
    changesDiscard: async (params: {
      names: string[];
      ifMatch?: Record<string, string | null>;
    }) => {
      server.discardCalls.push(params);
      if (server.conflict) {
        throw new ContentProtocolError(ErrorCode.Conflict, "changed", {
          entries: {},
        });
      }
      dropFromDraft(params.names);
      return {
        revision: revision(),
        versions: Object.fromEntries(params.names.map((n) => [n, null])),
      };
    },
  } as unknown as ContentClient;
  const backend: ProtocolBackend = {
    kind: "protocol",
    source: "github",
    client,
    describe: {} as DescribeResult,
    cacheKeySuffix: "",
  };
  return {
    backend,
    applied,
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => release();
    },
  };
}

const publishTarget: PublishTarget = {
  orgSlug: ORG,
  virtualMcpId: VM,
  branch: BRANCH,
  threadId: "thread-1",
  fastPreview: true,
  baseBranch: "main",
  target: { kind: "connection", connectionId: "c" } as never,
  owner: "o",
  repo: "r",
  headBranch: BRANCH,
  coAuthor: null as never,
};

/** A v8 card: the entry behind it and the version its list showed. */
const homeEntry = { name: "pages-home", version: "v-home" };
const homeChange = {
  name: "Home",
  filepaths: [],
  entry: homeEntry,
} as unknown as PublishChange;
/** A v7 card: the file behind it. */
const homeFileChange = {
  name: "Home",
  filepaths: [HOME],
} as unknown as PublishChange;

/** `changes.list` over the fake draft: its own names. */
function changesList() {
  return {
    notModified: false,
    revision: `c-${revision()}`,
    base: { revision: `main-${server.head}`, resolvedRef: "main" },
    changes: Object.fromEntries([
      ...Object.keys(server.draft.set).map((name) => [
        name,
        { kind: "set", version: `v-${name}`, baseVersion: "b" },
      ]),
      ...server.draft.delete.map((name) => [
        name,
        { kind: "delete", version: null, baseVersion: "b" },
      ]),
    ]),
  };
}

let queryClient: QueryClient;
let reads: {
  pointer: number;
  status: number;
  releases: number;
  changes: number;
};

/** The editor's queries; the pointer's version is the draft's ETag. */
function mountEditorQueries() {
  reads = { pointer: 0, status: 0, releases: 0, changes: 0 };
  const watch = (queryKey: readonly unknown[], count: keyof typeof reads) =>
    new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => {
        reads[count]++;
        return count === "pointer"
          ? { draft: "d", version: `e${server.etag}` }
          : {};
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
  watch(KEYS.protocolDraftRead(ORG, VM, BRANCH), "pointer");
  watch(realGit.sandboxGitStatusQueryKey({ ...publishTarget }), "status");
  watch(KEYS.hostedReleases(ORG, VM), "releases");
  watch(KEYS.contentChanges(CACHE_KEY), "changes");
}

/** The editor's blocks, read through the content poll (as `useDecofile`). */
async function mountPolledBlocks(backend: ProtocolBackend) {
  new QueryObserver(queryClient, {
    queryKey: KEYS.decofile(CACHE_KEY),
    queryFn: async () =>
      (
        await pollProtocolContent(
          queryClient,
          backend,
          publishTarget,
          CACHE_KEY,
        )
      ).blocks,
    staleTime: Number.POSITIVE_INFINITY,
  }).subscribe(() => {});
  await settle();
}

/** The editor's blocks, read the way the editor reads them (layered). */
async function mountBlocks() {
  new QueryObserver(queryClient, {
    queryKey: KEYS.decofile(CACHE_KEY),
    queryFn: async () => layered(),
    staleTime: Number.POSITIVE_INFINITY,
  }).subscribe(() => {});
  await settle();
}

const editorBlocks = () =>
  queryClient.getQueryData<Record<string, unknown>>(KEYS.decofile(CACHE_KEY));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(
  backend: ContentBackend,
  options: {
    hosted: boolean;
    refresh?: () => Promise<unknown>;
    onPublished?: () => void;
    /** The listed v8 entries ("discard all" drops them). */
    entries?: Array<{ name: string; version: string | null }>;
  },
) {
  currentTarget = {
    queryClient,
    orgSlug: ORG,
    virtualMcpId: VM,
    branch: BRANCH,
    backend,
    cacheKey: CACHE_KEY,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useCmsPublishActions({
        mode: "publish",
        target: publishTarget,
        note: "",
        allPaths: [HOME],
        destinationHost: null,
        publishLockRef: { current: false },
        onOpenChange: () => {},
        refresh: options.refresh ?? (async () => {}),
        onPublished: options.onPublished,
        hosted: options.hosted,
        ...(backend.kind === "protocol"
          ? {
              protocol: {
                backend,
                entries: options.entries ?? [homeEntry],
              },
            }
          : {}),
      }),
    { wrapper },
  );
}

const realFetch = globalThis.fetch;

beforeEach(async () => {
  queryClient = new QueryClient();
  discardGitFiles.mockClear();
  fetchGitDiff.mockClear();
  toasts.length = 0;
  resetServer();
  mountEditorQueries();
  await settle();
});

afterEach(() => {
  resetContentSync();
  globalThis.fetch = realFetch;
});

describe("useCmsPublishActions on a hosted v8 site", () => {
  it("a discard (changes.discard) removes the block from the draft, refreshes the editor and reloads the preview, driving both indicators", async () => {
    const { backend, applied } = hostedBackend();
    server.draft.set = { "pages-home": { title: "Discard me" } };
    await mountBlocks();
    expect(editorBlocks()).toEqual({ "pages-home": { title: "Discard me" } });
    const unregister = registerContentPreview(SCOPE);
    const { result } = render(backend, { hosted: true });
    const before = { ...reads };
    const pointerBefore = queryClient.getQueryData(
      KEYS.protocolDraftRead(ORG, VM, BRANCH),
    );

    let done!: Promise<void>;
    act(() => {
      done = result.current.discardChange(homeChange);
    });
    expect(getContentSyncState(SCOPE).phase).toBe("saving");
    await act(() => done);

    // The protocol, guarded by the version the list showed; never git.
    expect(server.discardCalls).toEqual([
      { names: ["pages-home"], ifMatch: { "pages-home": "v-home" } },
    ]);
    expect(discardGitFiles).not.toHaveBeenCalled();
    // No main sync: nothing read from main, nothing written over the draft.
    expect(fetchGitDiff).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
    expect(server.draft).toEqual({ set: {}, delete: [] });
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main" } });
    // A new draft object: a new pointer, which the preview navigates to.
    expect(
      queryClient.getQueryData(KEYS.protocolDraftRead(ORG, VM, BRANCH)),
    ).not.toEqual(pointerBefore);
    expect(reads.pointer).toBe(before.pointer + 1);
    // The changes list re-reads; a hosted draft never reads git's status.
    expect(reads.changes).toBe(before.changes + 1);
    expect(reads.status).toBe(before.status);
    expect(toasts).toEqual([{ kind: "success", message: expect.any(String) }]);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      epoch: 1,
      reload: { navigates: true },
    });
    confirmPreviewReloaded(SCOPE);
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
    unregister();
  });

  it("after a discard the editor's poll reads the base's blocks back (it doesn't adopt the discard's revision as already read)", async () => {
    const { backend } = hostedBackend();
    server.draft.set = { "pages-home": { title: "Discard me" } };
    await mountPolledBlocks(backend);
    expect(editorBlocks()).toEqual({ "pages-home": { title: "Discard me" } });
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.discardChange(homeChange));
    await act(settle);
    expect(server.draft).toEqual({ set: {}, delete: [] });
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main" } });
    expect(
      queryClient.getQueryData(KEYS.contentRevision(CACHE_KEY)),
    ).toMatchObject({ revision: revision() });
  });

  it("discard all removes every changed block from the draft, 500 names per call", async () => {
    const { backend } = hostedBackend();
    const many = Array.from({ length: 501 }, (_, i) => `block-${i}`);
    server.draft = {
      set: {
        "pages-home": { title: "Discard me" },
        ...Object.fromEntries(many.map((name) => [name, { v: 1 }])),
      },
      delete: [],
    };
    await mountBlocks();
    const entries = [
      homeEntry,
      ...many.map((name) => ({ name, version: `v-${name}` })),
    ];
    const { result } = render(backend, { hosted: true, entries });
    await act(() => result.current.discardAll());
    expect(server.discardCalls.map((call) => call.names.length)).toEqual([
      500, 2,
    ]);
    expect(server.draft).toEqual({ set: {}, delete: [] });
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main" } });
  });

  it("a discard of an entry changed since the list was read: a calm note, nothing dropped, the list re-read", async () => {
    const { backend } = hostedBackend();
    server.draft.set = { "pages-home": { title: "Someone else's edit" } };
    server.conflict = true;
    await mountBlocks();
    const refresh = mock(async () => {});
    const { result } = render(backend, { hosted: true, refresh });
    await act(() => result.current.discardChange(homeChange));
    expect(server.draft.set).toEqual({
      "pages-home": { title: "Someone else's edit" },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ kind: "info", message: expect.any(String) }]);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
    });
  });

  it("discard, then main moves: the editor shows main's new version", async () => {
    const { backend } = hostedBackend();
    server.draft.set = { "pages-home": { title: "Discard me" } };
    await mountBlocks();
    const poll = () =>
      act(async () => {
        await pollProtocolContent(
          queryClient,
          backend,
          publishTarget,
          CACHE_KEY,
        );
        await settle();
      });
    await poll();
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.discardChange(homeChange));
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main" } });
    await poll();

    // Someone publishes to main; the editor's content poll sees a new revision.
    server.main = { "pages-home": { title: "main v2" } };
    server.head++;
    const epoch = getContentSyncState(SCOPE).epoch;
    const pointerReads = reads.pointer;
    await poll();
    // The draft holds nothing for the block: main's new version shows through.
    expect(server.draft).toEqual({ set: {}, delete: [] });
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main v2" } });
    // Someone else's change: the open form re-reads, the preview reloads.
    expect(getContentSyncState(SCOPE).epoch).toBe(epoch + 1);
    expect(reads.pointer).toBe(pointerReads + 1);
  });

  it("edit, then discard at once: the save in flight lands first, the armed one is dropped, and the block ends at main", async () => {
    const { backend, applied, hold } = hostedBackend();
    await mountBlocks();
    const release = hold();
    const order: string[] = [];
    const dropped: string[][] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    // The form's next autosave, armed (debounced) but not sent.
    let armed: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      order.push("armed save");
      void applyProtocolPatch(queryClient, backend, publishTarget, CACHE_KEY, {
        set: { "pages-home": { title: "edited again" } },
      });
    }, 5);
    renderHook(
      () =>
        useContentDiscardListener(ORG, VM, (keys) => {
          dropped.push([...keys]);
          if (armed && keys.has("pages-home")) clearTimeout(armed);
          armed = null;
        }),
      { wrapper },
    );
    // The previous autosave, in the draft's write queue, still in flight.
    const save = queryClient
      .getMutationCache()
      .build(queryClient, {
        scope: decofileWriteScope(ORG, VM, BRANCH),
        mutationFn: async () => {
          await applyProtocolPatch(
            queryClient,
            backend,
            publishTarget,
            CACHE_KEY,
            { set: { "pages-home": { title: "edited" } } },
          );
          order.push("save");
        },
      })
      .execute(undefined);
    server.onDiscard = () => order.push("discard");
    const { result } = render(backend, { hosted: true });
    let done!: Promise<void>;
    act(() => {
      done = result.current.discardChange(homeChange);
    });
    expect(dropped).toEqual([["pages-home"]]);
    await settle();
    // Queued behind the save: nothing discarded yet.
    expect(order).toEqual([]);
    release();
    await act(() => Promise.all([save, done]).then(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["save", "discard"]);
    expect(applied).toEqual([{ set: { "pages-home": { title: "edited" } } }]);
    expect(server.draft).toEqual({ set: {}, delete: [] });
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main" } });
  });

  it("a failed discard clears the pending state", async () => {
    const { backend } = hostedBackend();
    server.failDiscard = true;
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.discardChange(homeChange));
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
      epoch: 0,
    });
  });

  it("a publish is a content change: the releases, pointer and status refresh", async () => {
    const { backend } = hostedBackend();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ result: "merged", sha: "abc", release: "current" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const onPublished = mock(() => {});
    const { result } = render(backend, { hosted: true, onPublished });
    const before = { ...reads };
    let done!: Promise<void>;
    act(() => {
      done = result.current.submit();
    });
    expect(getContentSyncState(SCOPE).phase).toBe("saving");
    await act(() => done);
    expect(calls).toEqual([`/api/${ORG}/decofile/${VM}/${BRANCH}/publish`]);
    expect(reads.releases).toBe(before.releases + 1);
    expect(reads.pointer).toBe(before.pointer + 1);
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
  });

  it("a failed publish clears the pending state and shows the error", async () => {
    const { backend } = hostedBackend();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "main-moved" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.submit());
    expect(result.current.publishError).toBeTruthy();
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
    });
  });
});

describe("useCmsPublishActions on a v7 site", () => {
  it("discard keeps its git path and re-reads the dialog, as on main", async () => {
    const refresh = mock(async () => {});
    const { result } = render({ kind: "legacy" }, { hosted: false, refresh });
    const before = { ...reads };
    await act(() => result.current.discardChange(homeFileChange));
    expect(discardGitFiles).toHaveBeenCalledWith(
      {
        orgSlug: ORG,
        virtualMcpId: VM,
        branch: BRANCH,
        threadId: "thread-1",
      },
      [HOME],
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reads).toEqual(before);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      epoch: 0,
    });
  });
});

describe("useCmsPublishActions on a v8 sandbox", () => {
  it("discards through changes.discard, re-reads the blocks, the changes and its git status, then has the open form re-read", async () => {
    const { backend: github } = hostedBackend();
    const backend: ProtocolBackend = { ...github, source: "sandbox" };
    let blockReads = 0;
    new QueryObserver(queryClient, {
      queryKey: KEYS.decofile(CACHE_KEY),
      queryFn: async () => {
        blockReads++;
        return { Home: { title: "main" } };
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
    await settle();
    const before = blockReads;
    const refresh = mock(async () => {});
    server.draft.set = { "pages-home": { title: "edited" } };
    const readsBefore = { ...reads };
    const { result } = render(backend, { hosted: false, refresh });
    await act(() => result.current.discardChange(homeChange));
    expect(discardGitFiles).not.toHaveBeenCalled();
    expect(server.discardCalls).toEqual([
      { names: ["pages-home"], ifMatch: { "pages-home": "v-home" } },
    ]);
    expect(blockReads).toBe(before + 1);
    expect(reads.changes).toBe(readsBefore.changes + 1);
    // A sandbox publishes with git: its header's status re-reads too.
    expect(reads.status).toBe(readsBefore.status + 1);
    // The list re-reads through the shared refresh, not the dialog's own.
    expect(refresh).not.toHaveBeenCalled();
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
      epoch: 1,
    });
  });
});
