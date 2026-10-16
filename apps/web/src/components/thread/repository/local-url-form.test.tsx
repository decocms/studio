import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { act, fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";
import { LocalUrlForm } from "./local-url-form";

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Types into a controlled field. happy-dom doesn't deliver input events to
 * React's change handling here, so this calls the field's own `onChange`
 * (as schemaless-content.test.tsx does).
 */
function type(element: HTMLElement, value: string) {
  const propsKey = Object.keys(element).find((k) =>
    k.startsWith("__reactProps$"),
  );
  const props = (element as unknown as Record<string, { onChange?: unknown }>)[
    propsKey ?? ""
  ];
  const onChange = props?.onChange as
    | ((event: { target: { value: string } }) => void)
    | undefined;
  if (!onChange) throw new Error("not a controlled field");
  act(() => onChange({ target: { value } }));
}

const MAIN_HINT =
  "Point preview and the CMS at your own dev server. Paste a public tunnel URL (e.g. ngrok, cloudflared) reachable from this browser.";

describe("LocalUrlForm (v7, as on main)", () => {
  const realFetch = globalThis.fetch;
  const fetchSpy = mock(async () => new Response(null, { status: 500 }));
  beforeEach(() => {
    fetchSpy.mockClear();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("saves localhost:3000 synchronously as a tunnel URL, with no request", () => {
    const onSave = mock((_url: string | null) => {});
    const { getByLabelText, getByRole } = renderBare(
      <LocalUrlForm url={null} onSave={onSave} />,
      { wrapper },
    );
    type(getByLabelText("Local tunnel URL"), "localhost:3000");
    fireEvent.click(getByRole("button", { name: "Save" }));
    // Called in the same tick: no probe, no "checking" state.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      productionUrlFromDomain("localhost:3000"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an empty field can't be saved", () => {
    const { getByRole } = renderBare(
      <LocalUrlForm url={null} onSave={() => {}} />,
      { wrapper },
    );
    expect(getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows main's hint, and Turn off clears a saved URL", () => {
    const onSave = mock((_url: string | null) => {});
    const { getByText, getByRole } = renderBare(
      <LocalUrlForm url="https://x.ngrok.app" onSave={onSave} />,
      { wrapper },
    );
    expect(getByText(MAIN_HINT)).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Turn off" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
