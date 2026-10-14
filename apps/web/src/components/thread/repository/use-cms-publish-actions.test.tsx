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
import { applyProtocolPatch } from "@/components/sections-editor/content-protocol-api";
import { decofileWriteScope } from "@/components/sections-editor/decofile-api";
import type { PublishChange } from "./publish-change-summary";
import type { PublishTarget } from "./publish-flow";
import * as realGit from "./sandbox-git-api";

const ORG = "acme";
const VM = "vm-1";
const BRANCH = "draft-1";
const CACHE_KEY = `${ORG}/${VM}/${BRANCH}`;
const SCOPE = contentSyncScope(ORG, VM);
const HOME = ".deco/blocks/pages-home.json";

const discardGitFiles = mock(async (..._args: unknown[]) => {});
/** main's version as the server diffs it when the discard runs. */
let mainDiff: () => Promise<realGit.GitDiffResult> = async () => ({
  diffs: {},
});
const fetchGitDiff = mock((..._args: unknown[]) => mainDiff());
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
    blocksApply: async (patch: unknown) => {
      applied.push(patch);
      if (gate) await gate;
      return { revision: `r${applied.length + 1}`, versions: {} };
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

const homeChange = {
  name: "Home",
  filepaths: [HOME],
} as unknown as PublishChange;

let queryClient: QueryClient;
let reads: { pointer: number; status: number; releases: number };
const pointer = { version: "e1" };

function mountEditorQueries() {
  reads = { pointer: 0, status: 0, releases: 0 };
  const watch = (queryKey: readonly unknown[], count: keyof typeof reads) =>
    new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => {
        reads[count]++;
        return count === "pointer"
          ? { draft: "d", version: pointer.version }
          : {};
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
  watch(KEYS.protocolDraftRead(ORG, VM, BRANCH), "pointer");
  watch(realGit.sandboxGitStatusQueryKey({ ...publishTarget }), "status");
  watch(KEYS.hostedReleases(ORG, VM), "releases");
}

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
  mainDiff = async () => ({ diffs: {} });
  pointer.version = "e1";
  mountEditorQueries();
  await settle();
});

afterEach(() => {
  resetContentSync();
  globalThis.fetch = realFetch;
});

describe("useCmsPublishActions on a hosted v8 site", () => {
  it("a discard writes main's version back, refreshes the editor and reloads the preview, driving both indicators", async () => {
    const { backend, applied, hold } = hostedBackend();
    queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
      "pages-home": { title: "Discard me" },
    });
    const unregister = registerContentPreview(SCOPE);
    const release = hold();
    pointer.version = "e2";
    mainDiff = async () => ({
      diffs: {
        [HOME]: { from: '{"title":"main"}', to: '{"title":"Discard me"}' },
      },
    });
    const { result } = render(backend, { hosted: true });
    const before = { ...reads };

    let done!: Promise<void>;
    act(() => {
      done = result.current.discardChange(homeChange);
    });
    expect(getContentSyncState(SCOPE).phase).toBe("saving");
    release();
    await act(() => done);

    expect(fetchGitDiff).toHaveBeenCalledWith(
      publishTarget,
      { base: "main" },
      { fastPreview: true },
    );
    expect(applied).toEqual([{ set: { "pages-home": { title: "main" } } }]);
    expect(discardGitFiles).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(CACHE_KEY),
      ),
    ).toEqual({
      "pages-home": { title: "main" },
    });
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

  it("main moved since the dialog loaded: the discard writes main's version as it is now", async () => {
    const { backend, applied } = hostedBackend();
    const { result } = render(backend, { hosted: true });
    // The dialog showed `{"title":"main v1"}`; main has moved on since.
    mainDiff = async () => ({
      diffs: {
        [HOME]: { from: '{"title":"main v2"}', to: '{"title":"Discard me"}' },
      },
    });
    await act(() => result.current.discardChange(homeChange));
    expect(fetchGitDiff).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([{ set: { "pages-home": { title: "main v2" } } }]);
    expect(discardGitFiles).not.toHaveBeenCalled();
  });

  it("main moved to the draft's body: the discard only drops the draft's entry", async () => {
    const { backend, applied } = hostedBackend();
    let blockReads = 0;
    new QueryObserver(queryClient, {
      queryKey: KEYS.decofile(CACHE_KEY),
      queryFn: async () => {
        blockReads++;
        return { "pages-home": { title: "Discard me" } };
      },
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
    await settle();
    const before = blockReads;
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.discardChange(homeChange));
    expect(applied).toEqual([]);
    expect(discardGitFiles).toHaveBeenCalledWith(publishTarget, [HOME], {
      fastPreview: true,
    });
    expect(blockReads).toBe(before + 1);
    expect(getContentSyncState(SCOPE).epoch).toBe(1);
  });

  it("a discard lands after the editor's save in flight, and reads main only then", async () => {
    const { backend, applied, hold } = hostedBackend();
    const release = hold();
    const order: string[] = [];
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
    mainDiff = async () => {
      order.push("read main");
      return {
        diffs: {
          [HOME]: { from: '{"title":"main"}', to: '{"title":"edited"}' },
        },
      };
    };
    const { result } = render(backend, { hosted: true });
    let done!: Promise<void>;
    act(() => {
      done = result.current.discardChange(homeChange);
    });
    await settle();
    expect(order).toEqual([]);
    release();
    await act(() => Promise.all([save, done]).then(() => {}));
    expect(order).toEqual(["save", "read main"]);
    expect(applied).toEqual([
      { set: { "pages-home": { title: "edited" } } },
      { set: { "pages-home": { title: "main" } } },
    ]);
  });

  it("a discard drops the editors' armed autosaves of its blocks before it writes", async () => {
    const { backend, applied } = hostedBackend();
    const dropped: string[][] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(
      () =>
        useContentDiscardListener(ORG, VM, (keys) => {
          dropped.push([...keys]);
          expect(applied).toEqual([]);
        }),
      { wrapper },
    );
    mainDiff = async () => ({
      diffs: {
        [HOME]: { from: '{"title":"main"}', to: '{"title":"Discard me"}' },
      },
    });
    const { result } = render(backend, { hosted: true });
    await act(() => result.current.discardChange(homeChange));
    expect(dropped).toEqual([["pages-home"]]);
    expect(applied).toHaveLength(1);
  });

  it("without main's version (the read failed), a discard asks the server to drop the entries, through the same refresh", async () => {
    const { backend, applied } = hostedBackend();
    mainDiff = async () => {
      throw new Error("offline");
    };
    const { result } = render(backend, { hosted: true });
    const before = { ...reads };
    await act(() => result.current.discardChange(homeChange));
    expect(applied).toEqual([]);
    expect(discardGitFiles).toHaveBeenCalledWith(publishTarget, [HOME], {
      fastPreview: true,
    });
    expect(reads.pointer).toBe(before.pointer + 1);
    expect(getContentSyncState(SCOPE)).toMatchObject({
      phase: "idle",
      epoch: 1,
    });
  });

  it("a failed discard clears the pending state", async () => {
    const { backend } = hostedBackend();
    discardGitFiles.mockImplementationOnce(async () => {
      throw new Error("nope");
    });
    mainDiff = async () => {
      throw new Error("offline");
    };
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
