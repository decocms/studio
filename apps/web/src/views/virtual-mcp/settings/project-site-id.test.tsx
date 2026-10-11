import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { act, fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { ProjectSiteId, projectSiteId } from "./project-site-id";

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

  describe("copy button", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    });

    it("copies the exact site id and says so", async () => {
      const written: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            written.push(text);
          },
        },
      });
      const { getByRole, getByText } = renderBare(
        <ProjectSiteId siteSlug="acme-store" />,
        { wrapper },
      );
      const button = getByRole("button", { name: "Copy site id" });
      // Hidden until the row is hovered or focused, unless the pointer is coarse.
      expect(button.classList.contains("opacity-0")).toBe(true);
      expect(button.classList.contains("opacity-100")).toBe(false);
      expect(button.className).toContain("group-hover:opacity-100");
      expect(button.className).toContain("pointer-coarse:opacity-100");
      await act(async () => {
        fireEvent.click(button);
      });
      expect(written).toEqual(["acme-store"]);
      expect(getByText("Site id copied to the clipboard")).toBeInTheDocument();
      // The check stays visible while the feedback shows.
      expect(button.classList.contains("opacity-100")).toBe(true);
      expect(button.querySelector("svg")).toHaveClass("text-success");
    });
  });

  it("shows a repo-backed legacy project's title slug; nothing for chat agents", () => {
    const repository = { url: "https://github.com/acme/store" };
    expect(
      projectSiteId({ title: "Acme", metadata: { siteSlug: "acme" } }),
    ).toBe("acme");
    expect(
      projectSiteId({ title: "legacy-store", metadata: { repository } }),
    ).toBe("legacy-store");
    expect(
      projectSiteId({ title: "Not A Slug", metadata: { repository } }),
    ).toBeNull();
    expect(projectSiteId({ title: "support", metadata: {} })).toBeNull();
    expect(projectSiteId({ title: "support", metadata: null })).toBeNull();
  });
});
