import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { ProjectSiteId } from "./project-site-id";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("ProjectSiteId", () => {
  it("shows the site id read-only, with why it can't change", () => {
    const { getByLabelText, getByText } = renderBare(
      <ProjectSiteId siteSlug="acme" />,
      { wrapper },
    );
    const input = getByLabelText("Site id");
    expect(input).toHaveValue("acme");
    expect(input).toHaveAttribute("readonly");
    expect(input).toBeDisabled();
    expect(
      getByText(
        "The site id can't change: CDN paths, tokens and asset URLs use it.",
      ),
    ).toBeInTheDocument();
  });
});
