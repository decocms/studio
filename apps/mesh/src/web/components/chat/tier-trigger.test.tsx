import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TierTriggerPure } from "./tier-trigger";

// TierTriggerPure resolves labels via useT(), which reads the language
// preference through TanStack Query — renders need a QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("TierTriggerPure", () => {
  const cloudGroup = (onSelect: (tier: string) => void = () => {}) => ({
    key: "cloud",
    rows: [
      {
        key: "fast",
        title: "Fast",
        subtitle: "Haiku",
        active: false,
        onSelect: () => onSelect("fast"),
      },
      {
        key: "smart",
        title: "Smart",
        subtitle: "Sonnet",
        active: true,
        onSelect: () => onSelect("smart"),
      },
      {
        key: "thinking",
        title: "Thinking",
        subtitle: "Opus",
        active: false,
        onSelect: () => onSelect("thinking"),
      },
    ],
  });

  it("closed pill shows tier name only", () => {
    const { getByRole, queryByText } = render(
      <TierTriggerPure tier="smart" groups={[cloudGroup()]} />,
    );
    expect(getByRole("button", { name: /Smart/i })).toBeInTheDocument();
    expect(queryByText(/Sonnet/)).toBeNull();
  });

  it("uses the local harness name for the closed pill when provided", () => {
    const { getByRole } = render(
      <TierTriggerPure
        tier="smart"
        pillIcon={<svg data-testid="claude-code-icon" />}
        pillLabel="Claude Code Smart"
        groups={[cloudGroup()]}
      />,
    );
    expect(
      getByRole("button", { name: "Claude Code Smart" }),
    ).toBeInTheDocument();
  });

  it("popover shows one row per group entry with its subtitle", () => {
    const { getByRole } = render(
      <TierTriggerPure tier="smart" groups={[cloudGroup()]} />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    expect(getByRole("menuitem", { name: /Fast/ }).textContent).toContain(
      "Haiku",
    );
    expect(getByRole("menuitem", { name: /Smart/ }).textContent).toContain(
      "Sonnet",
    );
    expect(getByRole("menuitem", { name: /Thinking/ }).textContent).toContain(
      "Opus",
    );
  });

  it("hides the subtitle line when a row has no subtitle", () => {
    const noSubtitle = {
      key: "cloud",
      rows: [
        { key: "fast", title: "Fast", active: false, onSelect: () => {} },
        { key: "smart", title: "Smart", active: true, onSelect: () => {} },
        {
          key: "thinking",
          title: "Thinking",
          active: false,
          onSelect: () => {},
        },
      ],
    };
    const { getByRole, getAllByRole, queryByText } = render(
      <TierTriggerPure tier="smart" groups={[noSubtitle]} />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    expect(getAllByRole("menuitem")).toHaveLength(3);
    expect(queryByText(/Haiku/)).toBeNull();
  });

  it("calls the row's onSelect and closes when a row is clicked", () => {
    const onSelect = mock((_tier: string) => {});
    const { getByRole, queryByRole } = render(
      <TierTriggerPure tier="smart" groups={[cloudGroup(onSelect)]} />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    fireEvent.click(getByRole("menuitem", { name: /Thinking/ }));
    expect(onSelect).toHaveBeenCalledWith("thinking");
    expect(queryByRole("menuitem")).toBeNull();
  });

  it("renders grouped runtimes with headings and scopes row labels", () => {
    const groups = [
      {
        key: "claude-code",
        label: "Claude Code",
        rows: [
          {
            key: "claude-smart",
            title: "Smart",
            subtitle: "Sonnet 5",
            active: true,
            onSelect: () => {},
          },
        ],
      },
      {
        key: "codex",
        label: "Codex",
        rows: [
          {
            key: "codex-smart",
            title: "Smart",
            subtitle: "GPT-5.6 Terra",
            active: false,
            onSelect: () => {},
          },
        ],
      },
    ];
    const { getByRole } = render(
      <TierTriggerPure tier="smart" groups={groups} />,
    );
    fireEvent.click(getByRole("button", { name: /Smart/i }));
    // Both groups expose a "Smart" row — the group label disambiguates them.
    expect(
      getByRole("menuitem", { name: "Claude Code Smart" }).textContent,
    ).toContain("Sonnet 5");
    expect(
      getByRole("menuitem", { name: "Codex Smart" }).textContent,
    ).toContain("GPT-5.6 Terra");
  });
});
