import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "bun:test";
import { ShellRouteLoading } from "./shell-route-loading";

describe("ShellRouteLoading", () => {
  it("centers route loading across the whole routed content area", () => {
    const { getByTestId } = render(<ShellRouteLoading />);

    expect(getByTestId("shell-route-loading")).toHaveClass(
      "absolute",
      "inset-0",
      "flex",
      "items-center",
      "justify-center",
    );
  });
});
