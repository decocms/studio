import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CommerceOnboardingLoading } from "./loading-state";
import { CompanionMcpsSectionSkeleton } from "./companion-mcps-section";

// useT() reads language preference through TanStack Query — renders need a
// QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("commerce onboarding loading state", () => {
  test("renders the full-page loading shell", () => {
    const { getByRole, getByText } = render(
      <CommerceOnboardingLoading variant="workspace" />,
    );

    expect(getByRole("status")).toBeInTheDocument();
    expect(
      getByText("Preparing your commerce workspace..."),
    ).toBeInTheDocument();
  });

  test("renders the diagnostic card skeleton loading state", () => {
    const { getByText, container } = render(<CompanionMcpsSectionSkeleton />);

    expect(
      getByText("Connect your tools to see the full diagnostic"),
    ).toBeInTheDocument();
    // 4 skeleton cards × 4 pulse nodes each (icon, title, benefit line, action)
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(16);
  });
});
