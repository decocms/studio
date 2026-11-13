import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import {
  type ContentIndex,
  type HostedCall,
  type HostedRpc,
  useEnsureHostedBlocks,
} from "@/cms/hosted-content";

const CACHE_KEY = "acme/vm-1/draft-1";

/** `cms.blocks` answers `home`, failing (Unavailable) the first `failures` calls. */
function rpcFailing(failures: { left: number; retryAfterMs?: number }) {
  const calls: string[][] = [];
  const rpc: HostedRpc = {
    batch: async (batch: HostedCall[]) =>
      batch.map((call) => {
        const names = (call.params as { names: string[] }).names;
        calls.push(names);
        if (failures.left > 0) {
          failures.left--;
          return {
            ok: false as const,
            error: new ContentProtocolError(
              ErrorCode.Unavailable,
              "busy",
              failures.retryAfterMs !== undefined
                ? { retryAfterMs: failures.retryAfterMs }
                : undefined,
            ),
          };
        }
        return {
          ok: true as const,
          result: {
            blocks: { home: { __resolveType: "page", path: "/" } },
            versions: { home: "vH" },
            missing: [],
          },
        };
      }),
  };
  return { rpc, calls };
}

function render(rpc: HostedRpc) {
  const queryClient = new QueryClient();
  queryClient.setQueryData<ContentIndex>(KEYS.contentIndex(CACHE_KEY), {
    revision: "t1",
    resolvedRef: null,
    sequence: 1,
    entries: { home: { version: "vH", meta: { type: "page", path: "/" } } },
    draft: {},
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useEnsureHostedBlocks(rpc, CACHE_KEY, ["home"]), {
    wrapper,
  });
}

describe("useEnsureHostedBlocks: a failed load", () => {
  it("is tried again on its own, after the wait the server asked for, and ends loaded", async () => {
    const { rpc, calls } = rpcFailing({ left: 1, retryAfterMs: 300 });
    const { result } = render(rpc);
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.failed).toBe(false);
    expect(calls).toEqual([["home"], ["home"]]);
  });

  it("can be tried again at once", async () => {
    // A long wait: only `retry` reads it again within the test.
    const { rpc, calls } = rpcFailing({ left: 1, retryAfterMs: 60_000 });
    const { result } = render(rpc);
    await waitFor(() => expect(result.current.failed).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(calls).toHaveLength(2);
  });
});

describe("useEnsureHostedBlocks: a body dropped from the cache", () => {
  it("is loaded again though the index didn't move its version, so the view never waits on it for good", async () => {
    const { rpc, calls } = rpcFailing({ left: 0 });
    const queryClient = new QueryClient();
    queryClient.setQueryData<ContentIndex>(KEYS.contentIndex(CACHE_KEY), {
      revision: "t1",
      resolvedRef: null,
      sequence: 1,
      entries: { home: { version: "vH", meta: { type: "page", path: "/" } } },
      draft: {},
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useEnsureHostedBlocks(rpc, CACHE_KEY, ["home"]),
      { wrapper },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(calls).toEqual([["home"]]);
    act(() => {
      queryClient.setQueryData<Record<string, unknown>>(
        KEYS.decofile(CACHE_KEY),
        {},
      );
    });
    await waitFor(() => expect(calls).toEqual([["home"], ["home"]]));
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});

describe("useEnsureHostedBlocks next to the decofile's own query", () => {
  it("leaves the decofile's queryFn in place: a refetch still reads the content", async () => {
    // Off hosted (no rpc) the hook only watches the decofile query that
    // useDecofile fetches. Mounted after it, it must not replace its queryFn.
    const queryClient = new QueryClient();
    let reads = 0;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const decofile = useQuery<Record<string, unknown>>({
          queryKey: KEYS.decofile(CACHE_KEY),
          queryFn: async () => {
            reads++;
            return { home: { __resolveType: "page", read: reads } };
          },
        });
        useEnsureHostedBlocks(undefined, CACHE_KEY, ["home"]);
        return decofile.data;
      },
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        home: { __resolveType: "page", read: 1 },
      }),
    );
    await act(() =>
      queryClient.refetchQueries({
        queryKey: KEYS.decofile(CACHE_KEY),
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        home: { __resolveType: "page", read: 2 },
      }),
    );
  });
});
