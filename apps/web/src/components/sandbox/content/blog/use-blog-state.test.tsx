import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** The organization's brand folder is the only store: the guide and the campaigns beside it. */

const BASE = "brands/acme";

let remote: {
  brand: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  formats: Record<string, unknown> | null;
  campaigns: { id: string; data: Record<string, unknown> }[];
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

const { useBlogState } = await import("./use-blog-state");

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
    context: { tone: "Direto." },
    formats: null,
    campaigns: [{ id: "c1", data: { campaignName: "Natal" } }],
    versions: {
      [`${BASE}/brand.md`]: "g0",
      [`${BASE}/campaigns/c1.json`]: "h0",
    },
  };
});

describe("an organization with the feature off", () => {
  test("never asks for the state", () => {
    mount(false);
    expect(studioCall).not.toHaveBeenCalled();
  });
});

describe("an organization's state", () => {
  test("reads the brand and its writing rules as one record", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.brand).toEqual({
      companyName: "Acme",
      tone: "Direto.",
    });
  });

  test("a brand with no guide yet reads as empty", async () => {
    remote = { ...remote, brand: null, context: null };
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.brand).toEqual({});
  });

  test("lists its campaigns by id", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(
      result.current.campaigns.map(({ id, name }) => ({ id, name })),
    ).toEqual([{ id: "c1", name: "Natal" }]);
  });

  test("asks for the organization's state, with no project", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(studioCall).toHaveBeenCalledWith("BLOG_STATE_GET", {});
  });

  test("deleting a campaign names it for removal", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await result.current.remove.mutateAsync("c1");

    expect(sets[0]).toEqual({ removeCampaigns: ["c1"] });
  });
});
