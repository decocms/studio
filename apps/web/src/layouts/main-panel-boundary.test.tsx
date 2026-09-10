import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { PanelLoading } from "./main-panel-boundary";

/** It reads its accessible name through `useT`, which is TanStack-Query-backed
 *  (the language preference is a query). In the app it only ever renders under
 *  `RouterProvider`, which `providers.tsx` mounts inside the QueryClientProvider
 *  — so the provider here is fidelity, not scaffolding. */
function withQuery(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/**
 * Replaces the separate `ShellRouteLoading` and `MainPanelLoading` tests: the
 * app has ONE loader below the shell now, and the shape it must have changed
 * with the merge. `ShellRouteLoading` was `absolute inset-0`, which only landed
 * anywhere sensible when an ancestor happened to be positioned. This one is the
 * router's `defaultPendingComponent`, so it renders at whatever depth a route
 * forgot to name a loader — it has to lay itself out in static flow.
 */
describe("PanelLoading", () => {
  it("centers the spinner in static flow, so it works at any depth", () => {
    const { getByTestId } = render(withQuery(<PanelLoading />));

    expect(getByTestId("panel-loading")).toHaveClass(
      "flex",
      "flex-1",
      "h-full",
      "w-full",
      "items-center",
      "justify-center",
    );
  });

  /** The Spinner is `aria-hidden` unless labelled, and this loader is held for
   *  `defaultPendingMinMs` on every route change — unnamed, AT reads the region
   *  as empty rather than busy. */
  it("announces itself, rather than spinning silently", () => {
    const { getByRole } = render(withQuery(<PanelLoading />));

    expect(getByRole("status")).toHaveAccessibleName("Loading");
  });

  it("does not position itself absolutely", () => {
    const { getByTestId } = render(withQuery(<PanelLoading />));

    expect(getByTestId("panel-loading")).not.toHaveClass("absolute");
    expect(getByTestId("panel-loading")).not.toHaveClass("inset-0");
  });
});
