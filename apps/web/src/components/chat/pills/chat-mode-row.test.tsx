import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { render, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock BranchPicker so BranchPill tests don't pull in its heavy
// network/hook dependencies. The mock just renders a plain <button>
// so tests can assert the unlocked path forwards to BranchPicker.
mock.module("../../thread/github/branch-picker", () => ({
  BranchPicker: () => <button type="button">branch-picker</button>,
}));

import { ChatModeRowPure } from "./chat-mode-row";
import { BranchPill } from "./branch-pill";

// BranchPill resolves the locked-tooltip copy via useT(), which reads the
// language preference through TanStack Query — renders need a QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const renderWithQueryClient = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

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
    const { getByTestId } = renderWithQueryClient(
      <BranchPill {...BRANCH_PILL_PROPS} locked={true} />,
    );
    expect(getByTestId("branch-picker-locked")).toBeInTheDocument();
  });

  it("renders BranchPicker (a button) when locked=false", () => {
    const { getByRole } = renderWithQueryClient(
      <BranchPill {...BRANCH_PILL_PROPS} locked={false} />,
    );
    expect(getByRole("button")).toBeInTheDocument();
  });
});
