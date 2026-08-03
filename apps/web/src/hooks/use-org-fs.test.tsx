import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { afterEach, describe, expect, it, mock } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ProjectContextProvider,
  type OrganizationData,
} from "@/sdk/context/project-context";
import { useOrgFsList, type OrgFsEntry } from "./use-org-fs";

const orgA: OrganizationData = {
  id: "org-a",
  name: "A",
  slug: "a",
  logo: null,
};
const orgB: OrganizationData = {
  id: "org-b",
  name: "B",
  slug: "b",
  logo: null,
};

function entriesFor(orgSlug: string) {
  return [
    {
      path: `${orgSlug}-secret.txt`,
      kind: "file" as const,
      size: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

describe("useOrgFsList", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("does not show the previous org's listing as placeholder data after switching orgs", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    // org "b"'s fetch never resolves during the test — any data shown for it
    // must therefore be a real placeholder, not a fetched result.
    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/a/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ entries: entriesFor("a") }), {
            status: 200,
          }),
        );
      }
      return new Promise(() => {}); // org "b" — left pending
    }) as unknown as typeof fetch;

    const latest: {
      data: OrgFsEntry[] | undefined;
      isPlaceholderData: boolean;
    } = { data: undefined, isPlaceholderData: false };

    function Harness() {
      const list = useOrgFsList("home", "");
      latest.data = list.data;
      latest.isPlaceholderData = list.isPlaceholderData;
      return null;
    }

    function Tree({ org }: { org: OrganizationData }) {
      return (
        <QueryClientProvider client={client}>
          <ProjectContextProvider
            org={org}
            project={{ id: org.id, slug: "_org" }}
          >
            <Harness />
          </ProjectContextProvider>
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<Tree org={orgA} />);

    await waitFor(() => expect(latest.data?.[0]?.path).toBe("a-secret.txt"));

    rerender(<Tree org={orgB} />);

    // Org "b"'s request is still pending — without the org-scoped guard,
    // `keepPreviousData` would surface org "a"'s entries here.
    expect(latest.data).toBeUndefined();
    expect(latest.isPlaceholderData).toBe(false);
  });
});
