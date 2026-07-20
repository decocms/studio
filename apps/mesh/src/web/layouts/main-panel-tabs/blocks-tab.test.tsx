import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, test } from "bun:test";
import { BlocksEmptyState, BlocksErrorState } from "./blocks-tab-states";

describe("Blocks tab states", () => {
  test("offers non-technical Blocks setup guidance", () => {
    const { getByRole, getByText } = render(<BlocksEmptyState />);
    const link = getByRole("link", { name: "Set up content editing" });

    expect(
      getByRole("heading", {
        name: "Want to edit this website with easy-to-use forms?",
      }),
    ).toBeInTheDocument();
    expect(
      getByText(
        "Set up rich content editing so anyone can update pages without touching code.",
      ),
    ).toBeInTheDocument();

    expect(link).toHaveAttribute("href", "https://github.com/decocms/blocks");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  test("retries from the error state", () => {
    let retryCount = 0;
    const { getByRole } = render(
      <BlocksErrorState
        source="data"
        onRetry={() => {
          retryCount += 1;
        }}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retryCount).toBe(1);
  });
});
