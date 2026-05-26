import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useReleaseSeenState } from "./use-release-seen-state";
import { RELEASES } from "@/web/lib/release-feed";

const STORAGE_KEY = "studio.release-feed.v1";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useReleaseSeenState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("treats unknown ids as unseen", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });
    expect(result.current.isSeen("never-existed")).toBe(false);
  });

  it("marks an id as seen and persists to localStorage", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });

    act(() => {
      result.current.markSeen("composer-2-5");
    });

    expect(result.current.isSeen("composer-2-5")).toBe(true);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, { seenAt: string }>;
    expect(parsed["composer-2-5"]?.seenAt).toEqual(expect.any(String));
  });

  it("markSeen is idempotent — calling twice does not overwrite the timestamp", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });

    act(() => {
      result.current.markSeen("composer-2-5");
    });
    const firstRaw = localStorage.getItem(STORAGE_KEY)!;

    act(() => {
      result.current.markSeen("composer-2-5");
    });
    const secondRaw = localStorage.getItem(STORAGE_KEY)!;

    expect(firstRaw).toBe(secondRaw);
  });

  it("unseenCount reflects entries in RELEASES that have no seenAt", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });
    const total = RELEASES.length;
    expect(result.current.unseenCount).toBe(total);

    const first = RELEASES[0];
    if (!first) return;

    act(() => {
      result.current.markSeen(first.id);
    });

    expect(result.current.unseenCount).toBe(total - 1);
  });
});
