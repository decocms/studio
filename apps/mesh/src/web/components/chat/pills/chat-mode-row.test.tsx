import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatModeRowPure } from "./chat-mode-row";

describe("ChatModeRowPure", () => {
  it("returns null when virtual MCP is not clonable", () => {
    const { container } = render(
      <ChatModeRowPure
        clonable={false}
        connected={false}
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders ModePicker only when clonable but not connected (template)", () => {
    const { queryByTestId, getByTestId } = render(
      <ChatModeRowPure
        clonable={true}
        connected={false}
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(queryByTestId("branch-pill")).toBeNull();
    expect(getByTestId("mode-picker")).toBeInTheDocument();
  });

  it("renders BranchPill + ModePicker when connected", () => {
    const { getByTestId } = render(
      <ChatModeRowPure
        clonable={true}
        connected={true}
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(getByTestId("branch-pill")).toBeInTheDocument();
    expect(getByTestId("mode-picker")).toBeInTheDocument();
  });
});
