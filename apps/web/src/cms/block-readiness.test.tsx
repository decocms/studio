import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { KEYS } from "@/lib/query-keys";
import {
  createHostedRpc,
  useEnsureHostedBlocks,
  type ContentIndex,
} from "./hosted-content";

test("a deleted requested block waits for the parent's removal before opening a create form", async () => {
  const queryClient = new QueryClient();
  const cacheKey = "example/project/draft";
  queryClient.setQueryData<ContentIndex>(KEYS.contentIndex(cacheKey), {
    revision: "r1",
    resolvedRef: null,
    sequence: 1,
    entries: {},
    draft: {},
  });
  // A real client stays inert: an absent indexed name must never trigger a body request.
  const rpc = createHostedRpc("https://cms.example.test/rpc");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const source: Record<string, unknown> = {
    CMS: { __resolveType: "cms-settings" },
  };
  const { result, rerender, unmount } = renderHook(
    ({ listing }: { listing: Record<string, unknown> }) =>
      useEnsureHostedBlocks(rpc, cacheKey, ["CMS"], { listing }),
    { wrapper, initialProps: { listing: source } },
  );
  await waitFor(() => {
    expect(result.current.ready).toBe(false);
    expect(result.current.failed).toBe(false);
  });
  rerender({ listing: {} });
  await waitFor(() => expect(result.current.ready).toBe(true));
  unmount();
  queryClient.clear();
});
