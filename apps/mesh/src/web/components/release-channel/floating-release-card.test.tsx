import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const FRESH_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const OLD_DATE = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

function makeRelease(overrides: Partial<{ id: string; date: string }> = {}) {
  return {
    id: overrides.id ?? "fresh-release",
    date: overrides.date ?? FRESH_DATE,
    title: "Fresh Release",
    eyebrow: "Now Available",
    bullets: [],
  };
}

const RELEASES_MOCK: ReturnType<typeof makeRelease>[] = [];
const OLD_USER_CREATED_AT = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const NEW_USER_CREATED_AT = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

const releasesRef = {
  get current() {
    return RELEASES_MOCK;
  },
  set current(value: ReturnType<typeof makeRelease>[]) {
    RELEASES_MOCK.length = 0;
    RELEASES_MOCK.push(...value);
  },
};

const sessionRef = {
  current: {
    user: {
      id: "user-1",
      createdAt: OLD_USER_CREATED_AT,
    },
  },
};

mock.module("@/web/lib/release-feed", () => ({
  RELEASES: RELEASES_MOCK,
}));

mock.module("@/web/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: sessionRef.current }),
  },
}));

import { FloatingReleaseCard } from "./floating-release-card";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("FloatingReleaseCard", () => {
  beforeEach(() => {
    localStorage.clear();
    releasesRef.current = [];
    sessionRef.current = {
      user: {
        id: "user-1",
        createdAt: OLD_USER_CREATED_AT,
      },
    };
  });
  afterEach(() => {
    localStorage.clear();
    releasesRef.current = [];
  });

  it("renders nothing when RELEASES is empty", () => {
    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the newest release is older than 30 days", () => {
    releasesRef.current = [makeRelease({ id: "stale", date: OLD_DATE })];
    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders the card when the newest release is fresh and unseen", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    const { getByRole, getByText, queryByRole } = render(
      <FloatingReleaseCard />,
      { wrapper },
    );
    expect(getByText("Fresh Release")).toBeInTheDocument();
    expect(
      getByRole("dialog", { name: "Release announcement" }),
    ).toHaveAttribute("data-slot", "announcement-card");
    expect(
      getByRole("dialog", { name: "Release announcement" }),
    ).not.toHaveClass("fixed");
    expect(
      queryByRole("region", { name: "Release announcement" }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the current user is less than seven days old", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    sessionRef.current = {
      user: {
        id: "new-user",
        createdAt: NEW_USER_CREATED_AT,
      },
    };

    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders the card when the current user is at least seven days old", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    sessionRef.current = {
      user: {
        id: "old-user",
        createdAt: OLD_USER_CREATED_AT,
      },
    };

    const { getByText } = render(<FloatingReleaseCard />, { wrapper });
    expect(getByText("Fresh Release")).toBeInTheDocument();
  });

  it("does not render when the newest release is already seen", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    localStorage.setItem(
      "studio.release-feed.v1",
      JSON.stringify({ fresh: { seenAt: new Date().toISOString() } }),
    );
    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("clicking the dismiss button marks the release as seen and unmounts the card", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    const { getByLabelText, queryByText } = render(<FloatingReleaseCard />, {
      wrapper,
    });
    fireEvent.click(getByLabelText("Dismiss release announcement"));
    expect(queryByText("Fresh Release")).toBeNull();
    const stored = JSON.parse(
      localStorage.getItem("studio.release-feed.v1") ?? "{}",
    );
    expect(stored.fresh?.seenAt).toEqual(expect.any(String));
  });
});
