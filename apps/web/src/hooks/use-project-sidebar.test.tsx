import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { Sidebar } from "@decocms/shared/project-sidebar";

const realSdk = await import("@/sdk");
mock.module("@/sdk", () => ({
  ...realSdk,
  useProjectContext: () => ({ org: { id: "org1", slug: "org1" } }),
}));

const { useUpdateSidebarPreferences, useUpdateProjectFolders } = await import(
  "./use-project-sidebar"
);
const { KEYS } = await import("@/lib/query-keys");

const BASE: Sidebar = {
  folders: [],
  preferences: { pinned: [], hidden: [], dismissed: [], hiddenFolders: [] },
  joinedAt: null,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useUpdateSidebarPreferences / useUpdateProjectFolders", () => {
  it("keeps a sibling write's optimistic value after an earlier write fails", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const key = KEYS.projectSidebar("org1");
    client.setQueryData(key, BASE);

    let prefsCall: (() => void) | undefined;
    const prefsGate = new Promise<void>((resolve) => {
      prefsCall = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      if (String(url).includes("SIDEBAR_PREFERENCES_SET")) {
        await prefsGate;
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({ folders: [{ id: "f1", name: "F", projectIds: [] }] }),
      );
    }) as unknown as typeof fetch;

    const { result: prefsResult } = renderHook(
      () => useUpdateSidebarPreferences(),
      { wrapper: wrapper(client) },
    );
    const { result: foldersResult } = renderHook(
      () => useUpdateProjectFolders(),
      { wrapper: wrapper(client) },
    );

    act(() => {
      prefsResult.current.mutate((prefs) => ({
        ...prefs,
        pinned: [...prefs.pinned, "p1"],
      }));
    });
    await waitFor(() =>
      expect(client.getQueryData<Sidebar>(key)?.preferences.pinned).toEqual([
        "p1",
      ]),
    );

    act(() => {
      foldersResult.current.mutate(() => [
        { id: "f1", name: "F", projectIds: [] },
      ]);
    });
    await waitFor(() =>
      expect(client.getQueryData<Sidebar>(key)?.folders).toHaveLength(1),
    );

    prefsCall?.();
    await waitFor(() => expect(prefsResult.current.isError).toBe(true));

    expect(client.getQueryData<Sidebar>(key)?.folders).toHaveLength(1);

    globalThis.fetch = originalFetch;
  });
});
