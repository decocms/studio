import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ContentClient, DescribeResult } from "@decocms/blocks/protocol";
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
 * own value leaves no entry; `/git/discard` removes the entries.
 */
const server = {
  main: {} as Record<string, unknown>,
  draft: { set: {} as Record<string, unknown>, delete: [] as string[] },
  etag: 1,
  /** main's head: it moves when someone publishes. */
  head: 1,
  discards: [] as string[][],
  failDiscard: false,
};

function resetServer() {
  server.main = { "pages-home": { title: "main" } };
  server.draft = { set: {}, delete: [] };
  server.etag = 1;
  server.head = 1;
  server.discards = [];
  server.failDiscard = false;
}

const revision = () => `${server.head}~e${server.etag}`;

/** What the editor and the preview read: the draft over main as it is now. */
function layered(): Record<string, unknown> {
  const blocks = { ...server.main, ...server.draft.set };
  for (const key of server.draft.delete) delete blocks[key];
  return blocks;
}

async function discardFromDraft(_target: unknown, paths: string[]) {
  if (server.failDiscard) throw new Error("nope");
  const keys = new Set(paths.flatMap((p) => blockKeyFromDiffPath(p) ?? []));
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
    // The content poll: blocks.list (layered) and schema.get.
    batch: async (calls: Array<{ method: string }>) =>
      calls.map((call) =>
        call.method === "blocks.list"
          ? {
              ok: true,
              result: {
                notModified: false,
                revision: revision(),
                resolvedRef: null,
                blocks: layered(),
                versions: {},
              },
            }
          : {
              ok: true,
              result: { notModified: false, version: "s1", schema: {} },
            },
      ),
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

const homeChange = {
  name: "Home",
  filepaths: [HOME],
} as unknown as PublishChange;

let queryClient: QueryClient;
let reads: { pointer: number; status: number; releases: number };

/** The editor's queries; the pointer's version is the draft's ETag. */
function mountEditorQueries() {
  reads = { pointer: 0, status: 0, releases: 0 };
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
      }),
    { wrapper },
  );
}

const realFetch = globalThis.fetch;

beforeEach(async () => {
  queryClient = new QueryClient();
  discardGitFiles.mockClear();
  fetchGitDiff.mockClear();
  resetServer();
  mountEditorQueries();
  await settle();
});

afterEach(() => {
  resetContentSync();
  globalThis.fetch = realFetch;
});

describe("useCmsPublishActions on a hosted v8 site", () => {
  it("a discard removes the block from the draft, refreshes the editor and reloads the preview, driving both indicators", async () => {
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

    expect(discardGitFiles).toHaveBeenCalledWith(publishTarget, [HOME], {
      fastPreview: true,
    });
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
    expect(reads.status).toBe(before.status + 1);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "reloading",
      epoch: 1,
      reload: { navigates: true },
    });
    confirmPreviewReloaded(SCOPE);
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
    unregister();
  });

  it("discard all removes every changed block from the draft", async () => {
    const { backend } = hostedBackend();
    server.draft = {
      set: { "pages-home": { title: "Discard me" } },
      delete: [],
    };
    await mountBlocks();
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.discardAll());
    expect(server.discards).toEqual([["pages-home"]]);
    expect(server.draft).toEqual({ set: {}, delete: [] });
    expect(editorBlocks()).toEqual({ "pages-home": { title: "main" } });
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
    discardGitFiles.mockImplementationOnce(async (target, paths) => {
      order.push("discard");
      await discardFromDraft(target, paths);
    });
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
    await act(() => result.current.discardChange(homeChange));
    expect(discardGitFiles).toHaveBeenCalledWith(
      {
        orgSlug: ORG,
        virtualMcpId: VM,
        branch: BRANCH,
        threadId: "thread-1",
      },
      [HOME],
      { fastPreview: true },
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
  it("discard keeps its git path, re-reads the blocks, then has the open form re-read", async () => {
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
    const { result } = render(backend, { hosted: false, refresh });
    await act(() => result.current.discardChange(homeChange));
    expect(discardGitFiles).toHaveBeenCalledTimes(1);
    expect(blockReads).toBe(before + 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      inFlight: 0,
      epoch: 1,
    });
  });
});
