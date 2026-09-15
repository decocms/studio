import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as tanstackRouter from "@tanstack/react-router";
import type { ReactNode } from "react";

const FRESH_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const OLD_DATE = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

type Cta =
  | { label: string; href: string }
  | { label: string; action: "download-app" }
  | { label: string; action: "start-tour" };

function makeRelease(
  overrides: Partial<{ id: string; date: string; cta: Cta }> = {},
) {
  return {
    id: overrides.id ?? "fresh-release",
    date: overrides.date ?? FRESH_DATE,
    title: "Fresh Release",
    eyebrow: "Now Available",
    bullets: [],
    cta: overrides.cta,
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

mock.module("@/lib/release-feed", () => ({
  RELEASES: RELEASES_MOCK,
}));

mock.module("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: sessionRef.current }),
  },
}));

/** The card is rendered without a RouterProvider, so the two router hooks it
 *  reads THROUGH (`useLeafRoutePath` -> `useRouterState`, `useScopeId` ->
 *  `useSearch`) are stubbed; everything else in the module stays real.
 *
 *  `navigateMock` is kept deliberately: the CTA must NOT navigate any more, and
 *  a spy that is asserted never-called is the only way a regression here fails
 *  a test rather than silently yanking the reader to another page. */
const navigateMock = mock(() => Promise.resolve());
const routeRef = {
  current: {
    fullPath: "/$org/home",
    search: {} as Record<string, unknown>,
    params: {} as { agentId?: string },
    staticData: {} as {
      mainView?: string;
      siteEditorView?: "preview" | "content" | "code";
    },
  },
};
mock.module("@tanstack/react-router", () => ({
  ...tanstackRouter,
  useNavigate: () => navigateMock,
  useParams: () => ({ org: "acme", ...routeRef.current.params }),
  useSearch: () => routeRef.current.search,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({
      matches: [
        {
          fullPath: routeRef.current.fullPath,
          staticData: routeRef.current.staticData,
        },
      ],
    }),
}));

/** Stubbed so the test never pulls driver.js (and its CSS) into the bun
 *  runtime; the tour's own steps are covered by `layout-tour/steps.test.ts`. */
const startLayoutTourMock = mock(() => {});
mock.module("@/components/layout-tour/layout-tour", () => ({
  startLayoutTour: startLayoutTourMock,
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
    navigateMock.mockClear();
    startLayoutTourMock.mockClear();
    routeRef.current = {
      fullPath: "/$org/home",
      search: {},
      params: {},
      staticData: {},
    };
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

  /** Inverted from "navigates to the org home first". The tour explains the
   *  screen you are on; navigating would throw away whatever the reader was
   *  doing to show them a page they did not ask for. */
  it("the start-tour CTA drives the tour in place, without navigating", () => {
    releasesRef.current = [
      makeRelease({
        id: "fresh",
        cta: { label: "Take the tour", action: "start-tour" },
      }),
    ];
    const { getByRole } = render(<FloatingReleaseCard />, { wrapper });

    fireEvent.click(getByRole("button", { name: "Take the tour" }));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(startLayoutTourMock).toHaveBeenCalledTimes(1);
  });

  it("tells the tour which surfaces the current route has", () => {
    releasesRef.current = [
      makeRelease({
        id: "fresh",
        cta: { label: "Take the tour", action: "start-tour" },
      }),
    ];
    // Scoped to a project, on the agents route with NO view named: project
    // surfaces, but not the Site Editor's.
    routeRef.current = {
      fullPath: "/$org/projects/$agentId/",
      search: {},
      params: { agentId: "vir_1" },
      staticData: { mainView: "overview" },
    };
    const { getByRole } = render(<FloatingReleaseCard />, { wrapper });

    fireEvent.click(getByRole("button", { name: "Take the tour" }));
    expect(startLayoutTourMock).toHaveBeenCalledWith(expect.anything(), {
      onOrgHome: false,
      inProject: true,
      onSiteEditor: false,
    });
  });

  /** The tab bar and branch selector are mounted with the Site Editor, so the
   *  tour is told about them only there — a project route that names another
   *  view must not claim the surface. */
  it("reports the Site Editor surface only when that view is open", () => {
    releasesRef.current = [
      makeRelease({
        id: "fresh",
        cta: { label: "Take the tour", action: "start-tour" },
      }),
    ];
    routeRef.current = {
      fullPath: "/$org/projects/$agentId/site-editor/",
      search: {},
      params: { agentId: "vir_1" },
      staticData: {
        mainView: "site-editor",
        siteEditorView: "preview",
      },
    };
    const { getByRole } = render(<FloatingReleaseCard />, { wrapper });

    fireEvent.click(getByRole("button", { name: "Take the tour" }));
    expect(startLayoutTourMock).toHaveBeenCalledWith(expect.anything(), {
      onOrgHome: false,
      inProject: true,
      onSiteEditor: true,
    });
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
