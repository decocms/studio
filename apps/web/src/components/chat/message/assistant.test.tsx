import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MessageAssistant } from "./assistant";
import type { ChatMessage } from "../types";

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
    // The shimmer sits on the text, inside the pill, so it never paints over the pill's fill.
    const detail = getByText("Deciding how to approach the request");
    expect(detail).toHaveClass("shimmer");
    expect(detail.parentElement).toHaveClass("bg-muted/50");
  });

  it("skips a part type this client build doesn't know instead of crashing", () => {
    const message = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }, { type: "future-part-kind" }],
    } as unknown as ChatMessage;

    const { getByText } = render(
      <MessageAssistant
        message={message}
        status="ready"
        isLast
        turnStartedAt={null}
      />,
    );

    expect(getByText("hello")).toBeInTheDocument();
  });
});
