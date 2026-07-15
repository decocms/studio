import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { Toolbar } from "./toolbar";

describe("Toolbar.Header", () => {
  it("stays above workspace surfaces", () => {
    const { getByTestId } = render(
      <Toolbar.Header data-testid="toolbar-header" />,
    );

    expect(getByTestId("toolbar-header")).toHaveClass("relative", "z-10");
  });
});
