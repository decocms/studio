import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { OrgFileOpenContext } from "./org-file-open-context";
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

describe("confirmed file references", () => {
  it("links plain and inline-code filenames, preserving links, URLs and code blocks", () => {
    const { container, unmount } = renderWithQueryClient(
      <OrgFileOpenContext.Provider
        value={{
          orgSlug: "org_example",
          threadId: "source_thread",
          outputFiles: new Set(["recipe.html"]),
          open: () => {},
        }}
      >
        <MemoizedMarkdown
          id="files"
          text={[
            "Saved as recipe.html. Also `recipe.html`.",
            "unknown.html and https://example.com/recipe.html stay unchanged.",
            "[existing link](https://example.com/recipe.html)",
            "```text\nrecipe.html\n```",
          ].join("\n\n")}
        />
      </OrgFileOpenContext.Provider>,
    );
    expect(container.querySelectorAll("button").length).toBe(3);
    expect(container.querySelectorAll("a").length).toBe(2);
    expect(container.textContent).toContain("unknown.html");
    unmount();
  });
});
