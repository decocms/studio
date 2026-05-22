import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentModelPopover } from "./agent-model-popover";
import { getAgentSections } from "./select-model/agent-models";

const ALL = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

const DECOPILOT_ONLY = getAgentSections({
  hasAnyKey: true,
  link: { online: false, capabilities: [] },
});

describe("AgentModelPopover", () => {
  test("renders the active agent's three tier rows and no tab bar", () => {
    const { getAllByRole, getAllByTestId } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    // Only one section is rendered.
    expect(getAllByTestId("agent-section")).toHaveLength(1);
    // Exactly 3 buttons (tier rows), no tab buttons.
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => !b.hasAttribute("aria-pressed"))).toBe(true);
  });

  test("renders the section matching activeAgent", () => {
    const { getByText, queryByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    expect(getByText("Haiku 4.5")).toBeInTheDocument();
    expect(queryByText("Fast")).toBeNull();
  });

  test("falls back to the first section when activeAgent is null", () => {
    const { getByText, queryByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent={null}
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    // Decopilot is first in ALL, so its tier labels are shown.
    expect(getByText("Fast")).toBeInTheDocument();
    expect(queryByText("Haiku 4.5")).toBeNull();
  });

  test("falls back to the first section when activeAgent is not in sections", () => {
    const { getByText } = render(
      <AgentModelPopover
        sections={DECOPILOT_ONLY}
        activeAgent="claude-code"
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    expect(getByText("Fast")).toBeInTheDocument();
  });

  test("clicking a tier row calls onSelect with (activeAgent, tier)", () => {
    const onSelect = mock(
      (
        _k: "decopilot" | "claude-code" | "codex",
        _t: "fast" | "smart" | "thinking",
      ) => {},
    );
    const { getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="smart"
        onSelect={onSelect}
      />,
    );
    getByText("Opus 4.7").click();
    expect(onSelect).toHaveBeenCalledWith("claude-code", "thinking");
  });

  test("clicking a tier row in the fallback section reports that section's kind", () => {
    const onSelect = mock(
      (
        _k: "decopilot" | "claude-code" | "codex",
        _t: "fast" | "smart" | "thinking",
      ) => {},
    );
    const { getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent={null}
        activeTier="smart"
        onSelect={onSelect}
      />,
    );
    getByText("Fast").click();
    expect(onSelect).toHaveBeenCalledWith("decopilot", "fast");
  });

  test("renders an empty container when sections is empty", () => {
    const { queryAllByTestId } = render(
      <AgentModelPopover
        sections={[]}
        activeAgent={null}
        activeTier="smart"
        onSelect={() => {}}
      />,
    );
    expect(queryAllByTestId("agent-section")).toHaveLength(0);
  });
});
