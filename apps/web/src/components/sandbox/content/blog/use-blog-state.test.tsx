import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * The library is the only store. A site that still carries the old
 * `blog-manager-*` blocks must not have them read: a form filling itself from
 * a store nothing writes to any more is worse than an empty one, because the
 * person edits it and the edit lands somewhere else.
 *
 * The write path's own trap is the version it writes against: the library
 * refuses a write whose base is stale, so a second edit that still quotes the
 * version its own first edit replaced is refused forever. That is what the
 * consecutive-writes test is for.
 */

const BASE = "projects/acme/Blog";

let remote: {
  brand: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  formats: Record<string, unknown> | null;
  campaigns: { id: string; data: Record<string, unknown> }[];
  campaignSeeds: { id: string; data: Record<string, unknown> }[];
  versions: Record<string, string>;
};

/** Every BLOG_STATE_SET this tab sent, so the `expect` it quoted is testable. */
let sets: Record<string, unknown>[] = [];
/** How many writes still have to be refused before one is accepted. */
let refuseNext = 0;
let hashCounter = 0;

const studioCall = mock(
  async (name: string, input: Record<string, unknown>) => {
    if (name === "BLOG_STATE_GET") return remote;
    sets.push(input);
    if (refuseNext > 0) {
      refuseNext -= 1;
      throw new Error("blog-state-conflict: brand.json changed");
    }
    hashCounter += 1;
    const written: { path: string; contentHash: string }[] = [];
    if (input.brand) {
      written.push({
        path: `${BASE}/brand.json`,
        contentHash: `h${hashCounter}`,
      });
    }
    for (const record of (input.campaigns ?? []) as { id: string }[]) {
      written.push({
        path: `${BASE}/campaigns/${record.id}.json`,
        contentHash: `h${hashCounter}`,
      });
    }
    return { written, removed: [] };
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
  renderHook(
    () => useBlogState({ orgSlug: "org", virtualMcpId: "vmcp_1", enabled }),
    { wrapper },
  );

beforeEach(() => {
  studioCall.mockClear();
  sets = [];
  refuseNext = 0;
  hashCounter = 0;
  remote = {
    brand: { companyName: "Acme" },
    context: null,
    formats: null,
    campaigns: [{ id: "c1", data: { campaignName: "Natal" } }],
    campaignSeeds: [],
    versions: { [`${BASE}/brand.json`]: "h0" },
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

  test("sends a singleton as its own field, quoting the version it read", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await result.current.save.mutateAsync({
      blockKey: "blog-manager-brand",
      data: { companyName: "Acme 2" },
    });

    expect(sets[0]).toMatchObject({
      virtualMcpId: "vmcp_1",
      brand: { companyName: "Acme 2" },
      expect: { [`${BASE}/brand.json`]: "h0" },
    });
  });

  test("writes a campaign to its own record, by id", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await result.current.save.mutateAsync({
      blockKey: "blog-manager/campaigns/c9",
      data: { campaignName: "Black Friday" },
    });

    expect(sets[0]?.campaigns).toEqual([
      { id: "c9", data: { campaignName: "Black Friday" } },
    ]);
  });

  test("a second edit quotes the version the first one produced", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await result.current.save.mutateAsync({
      blockKey: "blog-manager-brand",
      data: { companyName: "um" },
    });
    await result.current.save.mutateAsync({
      blockKey: "blog-manager-brand",
      data: { companyName: "dois" },
    });

    expect(sets[1]?.expect).toEqual({ [`${BASE}/brand.json`]: "h1" });
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

describe("when the file changed under the edit", () => {
  test("surfaces the choice instead of overwriting", async () => {
    refuseNext = 1;
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await result.current.save
      .mutateAsync({
        blockKey: "blog-manager-brand",
        data: { companyName: "meu" },
      })
      .catch(() => {});

    await waitFor(() =>
      expect(result.current.conflict).toBe("blog-manager-brand"),
    );
  });

  test("keeping mine rewrites without a precondition, and clears the choice", async () => {
    refuseNext = 1;
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    await result.current.save
      .mutateAsync({
        blockKey: "blog-manager-brand",
        data: { companyName: "meu" },
      })
      .catch(() => {});
    await waitFor(() => expect(result.current.conflict).not.toBeNull());

    result.current.keepMine();

    await waitFor(() => expect(result.current.conflict).toBeNull());
    expect(sets[1]?.expect).toBeUndefined();
    expect(sets[1]?.brand).toEqual({ companyName: "meu" });
  });

  test("reloading theirs drops the held edit", async () => {
    refuseNext = 1;
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    await result.current.save
      .mutateAsync({
        blockKey: "blog-manager-brand",
        data: { companyName: "meu" },
      })
      .catch(() => {});
    await waitFor(() => expect(result.current.conflict).not.toBeNull());

    result.current.reloadTheirs();

    await waitFor(() => expect(result.current.conflict).toBeNull());
    result.current.keepMine();
    expect(sets).toHaveLength(1);
  });
});
