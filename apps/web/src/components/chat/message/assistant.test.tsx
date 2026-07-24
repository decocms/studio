import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MessageAssistant } from "./assistant";

// MessageAssistant resolves copy via useT(), which reads the language
// preference through TanStack Query — renders need a QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("MessageAssistant", () => {
  it("renders the empty waiting state with shared thought-summary row copy", () => {
    const { getByText } = render(
      <MessageAssistant
        message={null}
        status="submitted"
        isLast
        turnStartedAt={null}
      />,
    );

    expect(getByText("Planning next moves...")).toBeInTheDocument();
    expect(getByText("Deciding how to approach the request")).toHaveClass(
      "bg-muted/50",
    );
  });
});
