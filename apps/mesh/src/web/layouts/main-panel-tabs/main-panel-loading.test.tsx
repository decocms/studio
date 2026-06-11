import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { MainPanelLoading } from "./main-panel-loading";

describe("MainPanelLoading", () => {
  it("centers the spinner across the full panel", () => {
    const { getByTestId } = render(<MainPanelLoading />);

    expect(getByTestId("main-panel-loading")).toHaveClass(
      "flex",
      "h-full",
      "w-full",
      "items-center",
      "justify-center",
    );
  });
});
