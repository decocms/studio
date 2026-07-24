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
  it("returns null when the branch pill is null", () => {
    const { container } = render(<ChatModeRowPure branchPill={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the BranchPill when present", () => {
    const { getByTestId } = render(
      <ChatModeRowPure
        branchPill={<span data-testid="branch-pill">branch</span>}
      />,
    );
    expect(getByTestId("branch-pill")).toBeInTheDocument();
  });
});

const BRANCH_PILL_PROPS = {
  orgId: "org-1",
  orgSlug: "my-org",
  userId: "user-1",
  userLabel: "Test User",
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
