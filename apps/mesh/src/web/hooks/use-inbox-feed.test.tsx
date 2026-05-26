import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock module dependencies BEFORE importing the SUT.
mock.module("@/web/hooks/use-pending-invitations", () => ({
  usePendingInvitations: () => [
    {
      id: "inv-1",
      organizationId: "org-1",
      organizationName: "Acme",
      email: "user@acme.test",
      role: "member",
      status: "pending",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
    },
  ],
}));

mock.module("@/web/lib/release-feed", () => ({
  RELEASES: [
    {
      id: "newer-release",
      date: "2026-05-20",
      title: "Newer",
      bullets: [],
    },
    {
      id: "older-release",
      date: "2026-01-10",
      title: "Older",
      bullets: [],
    },
  ],
}));

import { useInboxFeed } from "./use-inbox-feed";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useInboxFeed", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns releases + invitations sorted by date desc", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });
    const ids = result.current.items.map((item) =>
      item.type === "release" ? item.release.id : item.invitation.id,
    );
    // Invitation expires 2026-06-01 (most recent), then newer-release (2026-05-20), then older-release (2026-01-10).
    expect(ids).toEqual(["inv-1", "newer-release", "older-release"]);
  });

  it("flags every release with its seen state", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });
    const releases = result.current.items.filter(
      (i): i is Extract<typeof i, { type: "release" }> => i.type === "release",
    );
    expect(releases.every((r) => r.isSeen === false)).toBe(true);
  });

  it("redDotCount is unseen releases + pending invitations", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });
    expect(result.current.redDotCount).toBe(2 + 1);
  });

  it("markReleaseSeen flips isSeen for the matching release", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });

    act(() => {
      result.current.markReleaseSeen("newer-release");
    });

    const newer = result.current.items.find(
      (i) => i.type === "release" && i.release.id === "newer-release",
    );
    expect(newer && newer.type === "release" && newer.isSeen).toBe(true);
    expect(result.current.redDotCount).toBe(1 + 1);
  });
});
