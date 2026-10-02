import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoizedMarkdown } from "./markdown";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (text: string) =>
  renderBare(<MemoizedMarkdown id="t" text={text} />, { wrapper });

describe("MemoizedMarkdown links", () => {
  it("downloads an editor attachment under the name it was uploaded with", () => {
    const { getByText } = render(
      "[spec v2.pdf](/api/acme/fs/uploads/read?path=editor-files/0b7c.pdf)",
    );
    const link = getByText("spec v2.pdf").closest("a");
    expect(link).toHaveAttribute("download", "spec v2.pdf");
    expect(link).not.toHaveAttribute("target");
  });

  it("names the download from link text that markdown split into nodes", () => {
    const { container } = render(
      "[*draft* notes.pdf](/api/acme/fs/uploads/read?path=editor-files/0b7c.pdf)",
    );
    expect(container.querySelector("a")).toHaveAttribute(
      "download",
      "draft notes.pdf",
    );
  });

  it("keeps other links opening in a new tab", () => {
    const { getByText } = render("[docs](https://example.com/read)");
    const link = getByText("docs").closest("a");
    expect(link).not.toHaveAttribute("download");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
