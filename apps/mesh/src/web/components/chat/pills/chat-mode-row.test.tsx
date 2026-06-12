import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock BranchPicker so BranchPill tests don't pull in its heavy
// network/hook dependencies. The mock just renders a plain <button>
// so tests can assert the unlocked path forwards to BranchPicker.
mock.module("../../thread/github/branch-picker", () => ({
  BranchPicker: () => <button type="button">branch-picker</button>,
}));

import { ChatModeRowPure } from "./chat-mode-row";
import { BranchPill } from "./branch-pill";

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

  it("renders both pills, ModePicker before BranchPill", () => {
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
    // Harness (ModePicker) reads first so the user sees:
    // "using [Cloud] on branch [main]" left-to-right.
    expect(
      mode.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

const BRANCH_PILL_PROPS = {
  orgId: "org-1",
  orgSlug: "my-org",
  userId: "user-1",
  virtualMcpId: "vmcp-1",
  connectionId: "conn-1",
  owner: "acme",
  repo: "monorepo",
  sandboxMap: undefined,
  value: "main",
  onChange: () => {},
} as const;

describe("BranchPill", () => {
  it("renders the lock chip when locked=true", () => {
    const { getByTestId } = render(
      <BranchPill {...BRANCH_PILL_PROPS} locked={true} />,
    );
    expect(getByTestId("branch-picker-locked")).toBeInTheDocument();
  });

  it("renders BranchPicker (a button) when locked=false", () => {
    const { getByRole } = render(
      <BranchPill {...BRANCH_PILL_PROPS} locked={false} />,
    );
    expect(getByRole("button")).toBeInTheDocument();
  });
});
