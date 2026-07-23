import { setupComponentTest } from "@/test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { KEYS } from "@/lib/query-keys";
import { useDeleteBlogBlock } from "./use-blog-mutations";

const params = { orgSlug: "acme", virtualMcpId: "vmid-1", branch: "main" };
const previewUrl = "https://preview.example.com";

describe("useDeleteBlogBlock", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, existed: true }), {
          status: 200,
        }),
      )) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("invalidates the live-meta query cached under its previewUrl-suffixed key", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Mirrors how useLiveMeta actually keys its cache entry, including the
    // previewUrl segment the delete mutation doesn't otherwise know about.
    const liveMetaKey = KEYS.liveMeta(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
      previewUrl,
    );
    client.setQueryData(liveMetaKey, { ok: true });

    function wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useDeleteBlogBlock(params), {
      wrapper,
    });

    act(() => {
      result.current.mutate({ blockKey: "posts/hello-world" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(liveMetaKey)?.isInvalidated).toBe(true);
  });
});
