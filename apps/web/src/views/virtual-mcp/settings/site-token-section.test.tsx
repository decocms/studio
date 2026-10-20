import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import {
  act,
  fireEvent,
  render as renderBare,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { SiteTokenSection } from "./site-token-section";

// Queried lazily: the DOM exists only after setupComponentTest runs.
const screen = () => within(document.body);

// A synthetic token: its parts decode to {"alg":"EdDSA"}, {"site":"acme-store"}
// and "signature"; nothing verifies it.
const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJzaXRlIjoiYWNtZS1zdG9yZSJ9.c2lnbmF0dXJl"; // gitleaks:allow

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("SiteTokenSection", () => {
  const originalFetch = globalThis.fetch;
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  let written: string[];

  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? { token: TOKEN }
            : { site: "acme-store", tokens: [] },
        ),
        { status: init?.method === "POST" ? 201 : 200 },
      )) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalClipboard)
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows the site id read-only with a hover copy button that copies it", async () => {
    renderBare(<SiteTokenSection orgSlug="acme" virtualMcpId="vir_1" />, {
      wrapper,
    });
    const input = await screen().findByLabelText("Site ID", { exact: true });
    expect(input).toHaveValue("acme-store");
    expect(input).toHaveAttribute("readonly");
    expect(
      screen().getByText(
        "The site ID can't change: CDN paths, tokens and asset URLs use it.",
      ),
    ).toBeInTheDocument();

    const button = screen().getByRole("button", { name: "Copy site ID" });
    // Hidden until the row is hovered or focused, unless the pointer is coarse.
    expect(button.classList.contains("opacity-0")).toBe(true);
    expect(button.classList.contains("opacity-100")).toBe(false);
    expect(button.className).toContain("group-hover:opacity-100");
    expect(button.className).toContain("group-focus-within:opacity-100");
    expect(button.className).toContain("pointer-coarse:opacity-100");

    await act(async () => {
      fireEvent.click(button);
    });
    expect(written).toEqual(["acme-store"]);
    expect(
      screen().getByText("Site ID copied to the clipboard"),
    ).toBeInTheDocument();
    expect(button.classList.contains("opacity-100")).toBe(true);
    expect(button.querySelector("svg")).toHaveClass("text-success");
  });

  it("copies the exact site token from the one-time dialog", async () => {
    renderBare(<SiteTokenSection orgSlug="acme" virtualMcpId="vir_1" />, {
      wrapper,
    });
    await screen().findByLabelText("Site ID", { exact: true });
    await act(async () => {
      fireEvent.click(screen().getByRole("button", { name: "Issue token" }));
    });
    const button = await screen().findByRole("button", {
      name: "Copy site token",
    });
    expect(
      screen().getByRole("textbox", { name: "Copy your site token" }),
    ).toHaveValue(TOKEN);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(written).toEqual([TOKEN]);
    expect(
      screen().getByText("Site token copied to the clipboard"),
    ).toBeInTheDocument();
    expect(button.querySelector("svg")).toHaveClass("text-success");
  });
});
