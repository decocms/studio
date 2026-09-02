import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { PanelLoading } from "./main-panel-boundary";

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
    const { getByTestId } = render(<PanelLoading />);

    expect(getByTestId("panel-loading")).toHaveClass(
      "flex",
      "flex-1",
      "h-full",
      "w-full",
      "items-center",
      "justify-center",
    );
  });

  it("does not position itself absolutely", () => {
    const { getByTestId } = render(<PanelLoading />);

    expect(getByTestId("panel-loading")).not.toHaveClass("absolute");
    expect(getByTestId("panel-loading")).not.toHaveClass("inset-0");
  });
});
