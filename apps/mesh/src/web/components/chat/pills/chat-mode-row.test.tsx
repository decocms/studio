import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatModeRowPure } from "./chat-mode-row";

describe("ChatModeRowPure", () => {
  it("returns null when both pills are null", () => {
    const { container } = render(
      <ChatModeRowPure branchPill={null} modePicker={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders only the BranchPill when ModePicker is null", () => {
    const { getByTestId, queryByTestId } = render(
      <ChatModeRowPure
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={null}
      />,
    );
    expect(getByTestId("branch-pill")).toBeInTheDocument();
    expect(queryByTestId("mode-picker")).toBeNull();
  });

  it("renders only the ModePicker when BranchPill is null", () => {
    const { getByTestId, queryByTestId } = render(
      <ChatModeRowPure
        branchPill={null}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(getByTestId("mode-picker")).toBeInTheDocument();
    expect(queryByTestId("branch-pill")).toBeNull();
  });

  it("renders both pills, BranchPill before ModePicker", () => {
    const { getByTestId } = render(
      <ChatModeRowPure
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    const branch = getByTestId("branch-pill");
    const mode = getByTestId("mode-picker");
    expect(branch).toBeInTheDocument();
    expect(mode).toBeInTheDocument();
    // Branch comes first in document order so the user reads:
    // "branch [main] using [Cloud]" left-to-right.
    expect(
      branch.compareDocumentPosition(mode) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
