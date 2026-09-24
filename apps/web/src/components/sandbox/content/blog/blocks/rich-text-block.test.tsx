import { setupComponentTest } from "../../../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render as renderBare } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RichTextBlock } from "./rich-text-block";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("RichTextBlock", () => {
  it("applies an external html rewrite instead of keeping the stale content", async () => {
    const { findByText, queryByText, rerender } = render(
      <RichTextBlock html="<p>original</p>" onChange={() => {}} />,
    );

    expect(await findByText("original")).toBeInTheDocument();

    rerender(<RichTextBlock html="<p>rewritten</p>" onChange={() => {}} />);

    expect(await findByText("rewritten")).toBeInTheDocument();
    expect(queryByText("original")).not.toBeInTheDocument();
  });
});
