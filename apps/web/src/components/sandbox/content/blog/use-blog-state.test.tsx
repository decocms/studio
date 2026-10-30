import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * The organization's brand folder is the only store. A site that still carries
 * the old `blog-manager-*` blocks must not have them read: a form filling
 * itself from a store nothing writes to any more is worse than an empty one,
 * because the person edits it and the edit lands somewhere else.
 */

const BASE = "brands/acme";

let remote: {
  brand: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  formats: Record<string, unknown> | null;
  campaigns: { id: string; data: Record<string, unknown> }[];
  campaignSeeds: { id: string; data: Record<string, unknown> }[];
  versions: Record<string, string>;
};

/** Every BLOG_STATE_SET this tab sent. */
let sets: Record<string, unknown>[] = [];

const studioCall = mock(
  async (name: string, input: Record<string, unknown>) => {
    if (name === "BLOG_STATE_GET") return remote;
    sets.push(input);
    return { written: [], removed: [] };
  },
);

mock.module("@/lib/studio-tools", () => ({
  useStudioTools: () => ({ orgSlug: "org", call: studioCall }),
}));

const { useBlogState, withoutBlogState } = await import("./use-blog-state");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const mount = (enabled = true) =>
  renderHook(() => useBlogState({ orgSlug: "org", enabled }), { wrapper });

beforeEach(() => {
  studioCall.mockClear();
  sets = [];
  remote = {
    brand: { companyName: "Acme" },
    context: null,
    formats: null,
    campaigns: [{ id: "c1", data: { campaignName: "Natal" } }],
    campaignSeeds: [],
    versions: {
      [`${BASE}/brand.md`]: "g0",
      [`${BASE}/campaigns/c1.json`]: "h0",
    },
  };
});

describe("a site that still carries the old blocks", () => {
  const LEGACY = {
    "blog-manager-brand": { companyName: "Loja antiga" },
    "blog-manager-context": { tone: "antigo" },
    "blog-manager-formats": { formats: [] },
    "blog-manager/campaigns/old": { campaignName: "Páscoa" },
    "blog-manager/campaign-seeds/old": { seedName: "Datas" },
    "blog-manager/posts/p1": { posts: { title: "Rascunho" } },
    "site/sections/Header.tsx": { __resolveType: "x" },
  };

  test("drops every one of them, and keeps the drafts and the site", () => {
    expect(Object.keys(withoutBlogState(LEGACY)).sort()).toEqual([
      "blog-manager/posts/p1",
      "site/sections/Header.tsx",
    ]);
  });

  test("leaves a decofile with none of them alone", () => {
    const clean = { "site/sections/Header.tsx": {} };
    expect(withoutBlogState(clean)).toEqual(clean);
  });
});

describe("an organization with the feature off", () => {
  test("never asks for the state", () => {
    mount(false);
    expect(studioCall).not.toHaveBeenCalled();
  });
});

describe("a site with none of it yet", () => {
  test("reads the library and presents it as decofile blocks", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.blocks).toEqual({
      "blog-manager-brand": { companyName: "Acme" },
      "blog-manager/campaigns/c1": { campaignName: "Natal" },
    });
  });

  test("asks for the organization's state, with no project", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(studioCall).toHaveBeenCalledWith("BLOG_STATE_GET", {});
  });

  test("deleting a campaign names it for removal", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await result.current.remove.mutateAsync({
      blockKey: "blog-manager/campaigns/c1",
    });

    expect(sets[0]).toMatchObject({ removeCampaigns: ["c1"] });
  });
});
