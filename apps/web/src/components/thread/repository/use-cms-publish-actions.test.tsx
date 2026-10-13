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
  type ContentSyncTarget,
} from "@/components/sections-editor/content-sync";
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
mock.module("./sandbox-git-api", () => ({ ...realGit, discardGitFiles }));
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
    diff?: realGit.GitDiffResult | null;
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
        diff: options.diff ?? null,
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
    const { result } = render(backend, {
      hosted: true,
      diff: {
        diffs: {
          [HOME]: { from: '{"title":"main"}', to: '{"title":"Discard me"}' },
        },
      },
    });
    const before = { ...reads };

    let done!: Promise<void>;
    act(() => {
      done = result.current.discardChange(homeChange);
    });
    expect(getContentSyncState(SCOPE).phase).toBe("saving");
    release();
    await act(() => done);

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

  it("without the bodies, a discard asks the server to drop the entries, through the same refresh", async () => {
    const { backend, applied } = hostedBackend();
    const { result } = render(backend, { hosted: true, diff: null });
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
    const { result } = render(backend, { hosted: true, diff: null });
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
    const { result } = render(
      { kind: "legacy" },
      { hosted: false, refresh, diff: { diffs: {} } },
    );
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
