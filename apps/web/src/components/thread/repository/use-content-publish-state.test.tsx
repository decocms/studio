import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import type {
  BatchCall,
  ContentClient,
  DescribeResult,
} from "@decocms/blocks/protocol";
import { KEYS } from "@/lib/query-keys";
import type {
  ContentSource,
  ProtocolBackend,
} from "@/components/sections-editor/content-backend";
import { useContentPublishState } from "./use-content-publish-state";

const CACHE_KEY = "acme/p1/feat";

/** A v8 source's changes: Home edited, Promo new; any source answers alike. */
function backendOf(source: ContentSource) {
  const calls: string[] = [];
  const client = {
    changesList: async () => {
      calls.push("changes.list");
      return {
        notModified: false,
        revision: "c1",
        base: { revision: "m1", resolvedRef: "main" },
        changes: {
          "pages-home": { kind: "set", version: "v1", baseVersion: "b1" },
          Promo: { kind: "set", version: "v2", baseVersion: null },
        },
      };
    },
    batch: async (batch: BatchCall[]) =>
      batch.map((call) => {
        calls.push(call.method);
        return {
          ok: true,
          result: {
            base: { revision: "m1", resolvedRef: "main" },
            entries: {
              "pages-home": {
                kind: "set",
                before: {
                  __resolveType: "website/pages/Page.tsx",
                  path: "/",
                  name: "Home",
                  title: "old",
                },
                after: {
                  __resolveType: "website/pages/Page.tsx",
                  path: "/",
                  name: "Home",
                  title: "new",
                },
                version: "v1",
                baseVersion: "b1",
              },
              Promo: {
                kind: "set",
                before: null,
                after: { title: "promo" },
                version: "v2",
                baseVersion: null,
              },
            },
            diagnostics: [],
          },
        };
      }),
  } as unknown as ContentClient;
  const backend: ProtocolBackend = {
    kind: "protocol",
    source,
    client,
    describe: {} as DescribeResult,
    cacheKeySuffix: "",
  };
  return { backend, calls };
}

describe("useContentPublishState", () => {
  for (const source of ["github", "sandbox", "local"] as const) {
    it(`lists and reads both sides through the protocol (${source})`, async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(KEYS.decofile(CACHE_KEY), {
        "pages-home": {
          __resolveType: "website/pages/Page.tsx",
          path: "/",
          name: "Home",
          title: "new",
        },
        Promo: { title: "promo" },
      });
      const { backend, calls } = backendOf(source);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={null}>{children}</Suspense>
        </QueryClientProvider>
      );
      const { result } = renderHook(
        () => useContentPublishState({ backend, cacheKey: CACHE_KEY }),
        { wrapper },
      );
      await waitFor(() => expect(result.current?.sidesPending).toBe(false));
      const state = result.current!;
      expect(state.summary.count).toBe(2);
      expect(state.entries).toEqual([
        { name: "pages-home", version: "v1" },
        { name: "Promo", version: "v2" },
      ]);
      const home = state.summary.pages[0]!;
      expect(home).toMatchObject({ name: "Home", status: "edited" });
      expect(home.fromJson).toEqual({
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        name: "Home",
        title: "old",
      });
      expect(state.summary.blocks[0]).toMatchObject({
        blockKey: "Promo",
        status: "new",
      });
      // One list, then the sides of every listed entry in one call.
      expect(calls).toEqual(["changes.list", "changes.get"]);
    });
  }
});
