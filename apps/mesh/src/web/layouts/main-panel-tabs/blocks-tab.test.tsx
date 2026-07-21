import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, test } from "bun:test";
import { BlocksEmptyState, BlocksErrorState } from "./blocks-tab-states";

// These states resolve copy via useT(), which reads the language preference
// through TanStack Query — renders need a QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("Blocks tab states", () => {
  test("offers non-technical Blocks setup guidance", () => {
    const { getByRole, getByText } = render(<BlocksEmptyState />);
    const link = getByRole("link", { name: "Set up content editing" });

    expect(
      getByRole("heading", {
        name: "Want to edit this website with easy-to-use forms?",
      }),
    ).toBeInTheDocument();
    expect(
      getByText(
        "Set up rich content editing so anyone can update pages without touching code.",
      ),
    ).toBeInTheDocument();

    expect(link).toHaveAttribute("href", "https://github.com/decocms/blocks");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  test("retries from the error state", () => {
    let retryCount = 0;
    const { getByRole } = render(
      <BlocksErrorState
        source="data"
        onRetry={() => {
          retryCount += 1;
        }}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retryCount).toBe(1);
  });
});
