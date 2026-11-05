import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import {
  type ContentIndex,
  type HostedCall,
  type HostedRpc,
  useEnsureHostedBlocks,
} from "./hosted-content";

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
