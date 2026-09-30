import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  OnePager,
  OnePagerItem,
} from "@decocms/shared/reports/public-report";
import OnePagerReport from "./onepager";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const render = (report: OnePager) =>
  renderBare(<OnePagerReport report={report} />, { wrapper });

const item = (overrides: Partial<OnePagerItem>): OnePagerItem => ({
  check_id: "PERF-001",
  title: "LCP within target",
  category: "Performance",
  severity: "error",
  pages: [],
  tasks: [],
  evidence: "LCP 4.1s on the home page",
  sources: [],
  ...overrides,
});

const report = (overrides: Partial<OnePager> = {}): OnePager => ({
  domain: "example.com",
  brand: "Example",
  scanned_at: "2026-09-20T12:00:00.000Z",
  lang: "en",
  score: 62,
  band: "Fair",
  totals: {
    measured: 10,
    registry_total: 20,
    passed: 7,
    failed: 2,
    blocked: 1,
  },
  buckets: [
    {
      id: "critical",
      label: "Crítico — resolver agora",
      items: [
        item({
          check_id: "PERF-001",
          controllability: "Deco-controllable",
          tasks: ["Preload the hero image"],
        }),
      ],
    },
    {
      id: "important",
      label: "Importante",
      items: [
        item({
          check_id: "SEC-002",
          title: "HSTS enabled",
          evidence: "No Strict-Transport-Security header",
          controllability: "External",
        }),
      ],
    },
    { id: "worth", label: "Vale fazer", items: [] },
  ],
  passing: { count: 1, items: [{ check_id: "SEO-001", title: "Has a title" }] },
  not_measured: {
    count: 1,
    groups: [
      {
        reason: "tool-auth",
        label: "Aguarda conexão",
        count: 1,
        checks: ["Revenue per session"],
      },
    ],
  },
  categories: [],
  screenshots: [],
  ...overrides,
});

describe("OnePagerReport", () => {
  beforeEach(() => localStorage.clear());

  test("renders every failed finding without a session, grouped by bucket", () => {
    const { getByRole, getByText, queryByText } = render(report());
    expect(getByRole("heading", { name: /Critical — fix now/ })).toBeTruthy();
    expect(getByRole("heading", { name: /Important/ })).toBeTruthy();
    // An empty bucket gets no heading.
    expect(queryByText("Worth doing")).toBeNull();
    // The finding body is in the DOM even while collapsed.
    expect(getByText("Preload the hero image")).toBeTruthy();
    expect(
      getByText("LCP 4.1s on the home page", { selector: ".dg-ev" }),
    ).toBeTruthy();
  });

  test("sends a fixable finding to onboarding with its check id", () => {
    const { getByRole } = render(report());
    const fix = getByRole("link", { name: "Fix automatically" });
    const url = new URL(fix.getAttribute("href") ?? "", "http://x");
    expect(url.pathname).toBe("/reports-onboarding");
    expect(url.searchParams.get("fix")).toBe("PERF-001");
    expect(url.searchParams.get("siteUrl")).toBe("https://example.com/");
  });

  test("says who a fix depends on instead of offering one", () => {
    const { getAllByRole, getByText } = render(report());
    expect(getAllByRole("link", { name: "Fix automatically" })).toHaveLength(1);
    expect(getByText(/depends on a third party/)).toBeTruthy();
  });

  test("links the Markdown mirror on Studio's own origin", () => {
    const { getByRole } = render(report());
    // In the language the findings are in, so the copied prompt matches.
    expect(getByRole("link", { name: "Open .md" })).toHaveAttribute(
      "href",
      "/report/example.com.md?lang=en",
    );
  });

  test("keeps blocked checks apart from passing ones, with the reason", () => {
    const { getByText } = render(report());
    expect(
      getByText(
        "Waiting for a data connection (GA4, Search Console, platform)",
      ),
    ).toBeTruthy();
    expect(getByText("Revenue per session")).toBeTruthy();
  });

  test("says so when nothing failed", () => {
    const { getByText } = render(
      report({
        buckets: [
          { id: "critical", label: "", items: [] },
          { id: "important", label: "", items: [] },
          { id: "worth", label: "", items: [] },
        ],
      }),
    );
    expect(getByText(/No check failed in this scan/)).toBeTruthy();
  });

  test("drops engine URLs that are not http(s)", () => {
    const { container } = render(
      report({
        favicon: "javascript:alert(1)",
        screenshots: [
          {
            url: "https://example.com/",
            page_type: "home",
            viewport: "desktop",
            image_url: "javascript:alert(1)",
          },
        ],
      }),
    );
    expect(container.querySelector('[src^="javascript:"]')).toBeNull();
    expect(container.querySelector(".dg-shots")).toBeNull();
  });
});
