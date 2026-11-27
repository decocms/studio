import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";

const state = {
  granted: true,
  flags: {} as Record<string, boolean>,
  writes: [] as Array<[string, boolean]>,
};

mock.module("@/hooks/use-capability", () => ({
  useCapability: () => ({ granted: state.granted }),
}));
mock.module("@/hooks/use-organization-settings", () => ({
  useOrgFlag: (flag: string) => state.flags[flag] ?? flag === "cms_auto_commit",
  useSetOrgFlag: () => ({
    isPending: false,
    mutate: (flag: string, value: boolean) => {
      state.writes.push([flag, value]);
    },
  }),
}));

const { BackgroundCommitRow } = await import("./background-commit-row");

// useT() reads the language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const LABEL = "Show saves before they are committed";

describe("BackgroundCommitRow", () => {
  beforeEach(() => {
    state.granted = true;
    state.flags = {};
    state.writes = [];
  });

  it("turns the organization flag on and off", () => {
    const { getByRole, rerender } = render(<BackgroundCommitRow />, {
      wrapper,
    });
    const toggle = getByRole("switch", { name: LABEL });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(state.writes).toEqual([["cms_background_commit", true]]);

    state.flags.cms_background_commit = true;
    rerender(<BackgroundCommitRow />);
    expect(getByRole("switch", { name: LABEL })).toBeChecked();
    fireEvent.click(getByRole("switch", { name: LABEL }));
    expect(state.writes.at(-1)).toEqual(["cms_background_commit", false]);
  });

  it("is hidden from members who cannot manage the organization", () => {
    state.granted = false;
    const { queryByText } = render(<BackgroundCommitRow />, { wrapper });
    expect(queryByText(LABEL)).not.toBeInTheDocument();
  });

  it("is hidden while saves are held until publish (auto-commit off)", () => {
    state.flags.cms_auto_commit = false;
    const { queryByText } = render(<BackgroundCommitRow />, { wrapper });
    expect(queryByText(LABEL)).not.toBeInTheDocument();
  });
});
