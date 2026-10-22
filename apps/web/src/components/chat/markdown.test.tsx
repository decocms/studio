import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoizedMarkdown } from "./markdown.tsx";

// useT() reads the language preference via TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const renderWithQueryClient = (ui: Parameters<typeof render>[0]) =>
  render(ui, { wrapper });

describe("MarkdownImage", () => {
  it("falls back to a non-empty alt when the markdown gives none", () => {
    const { container } = renderWithQueryClient(
      <MemoizedMarkdown id="img" text="![](https://example.com/photo.png)" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("Image");
  });
});
