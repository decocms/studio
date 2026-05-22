import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test, mock } from "bun:test";
import { act, render } from "@testing-library/react";
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

const CLAUDE_ONLY = getAgentSections({
  hasAnyKey: false,
  link: { online: true, capabilities: ["claude-code"] },
});

describe("AgentModelPopover", () => {
  test("renders one tab per eligible section", () => {
    const { getAllByRole } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const tabs = getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.textContent).toContain("Decopilot");
    expect(tabs[1]?.textContent).toContain("Claude Code");
    expect(tabs[2]?.textContent).toContain("Codex");
  });

  test("default active tab follows activeAgent", () => {
    const { getAllByRole, getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const tabs = getAllByRole("tab");
    const claudeTab = tabs.find((t) => t.textContent?.includes("Claude Code"));
    expect(claudeTab?.getAttribute("aria-selected")).toBe("true");
    // Claude Code body is rendered
    expect(getByText("Haiku 4.5")).toBeInTheDocument();
  });

  test("default active tab falls back to first section when activeAgent is not in sections", () => {
    const { getAllByRole } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent={null}
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const tabs = getAllByRole("tab");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.textContent).toContain("Decopilot");
  });

  test("clicking a tab switches the body content", () => {
    const { getAllByRole, queryByText, getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    // Body initially shows Decopilot tiers
    expect(queryByText("Haiku 4.5")).toBeNull();
    expect(getByText("Fast")).toBeInTheDocument();

    const tabs = getAllByRole("tab");
    const claudeTab = tabs.find((t) => t.textContent?.includes("Claude Code"))!;
    act(() => {
      claudeTab.click();
    });

    // Body now shows Claude Code tiers
    expect(getByText("Haiku 4.5")).toBeInTheDocument();
    expect(queryByText("Fast")).toBeNull();
  });

  test("clicking a tier row calls onSelect with (kind, tier)", () => {
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
        lockedAgent={null}
        onSelect={onSelect}
      />,
    );
    // Claude Code tab is active by default, so Haiku 4.5 is visible
    getByText("Haiku 4.5").click();
    expect(onSelect).toHaveBeenCalledWith("claude-code", "fast");
  });

  test("clicking a tier row after switching tabs uses the new agent", () => {
    const onSelect = mock(
      (
        _k: "decopilot" | "claude-code" | "codex",
        _t: "fast" | "smart" | "thinking",
      ) => {},
    );
    const { getAllByRole, getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={onSelect}
      />,
    );
    const tabs = getAllByRole("tab");
    act(() => {
      tabs.find((t) => t.textContent?.includes("Codex"))!.click();
    });
    getByText("Quicker responses").click();
    expect(onSelect).toHaveBeenCalledWith("codex", "fast");
  });

  test("when sections.length === 1, no tab bar is rendered", () => {
    const { queryByRole, queryAllByRole } = render(
      <AgentModelPopover
        sections={DECOPILOT_ONLY}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    expect(queryByRole("tablist")).toBeNull();
    expect(queryAllByRole("tab")).toHaveLength(0);
  });

  test("single section still selects tiers via onSelect", () => {
    const onSelect = mock(
      (
        _k: "decopilot" | "claude-code" | "codex",
        _t: "fast" | "smart" | "thinking",
      ) => {},
    );
    const { getByText } = render(
      <AgentModelPopover
        sections={CLAUDE_ONLY}
        activeAgent="claude-code"
        activeTier="smart"
        lockedAgent={null}
        onSelect={onSelect}
      />,
    );
    getByText("Opus 4.7").click();
    expect(onSelect).toHaveBeenCalledWith("claude-code", "thinking");
  });

  test("when lockedAgent is set, only that section renders and no tab bar shows", () => {
    const { queryByRole, queryByText, getByText, getAllByTestId } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent="claude-code"
        onSelect={() => {}}
      />,
    );
    expect(queryByRole("tablist")).toBeNull();
    expect(getAllByTestId("agent-section")).toHaveLength(1);
    // Claude tier labels visible
    expect(getByText("Haiku 4.5")).toBeInTheDocument();
    // Decopilot tier labels NOT visible
    expect(queryByText("Fast")).toBeNull();
  });

  test("lockedAgent still fires onSelect for the locked section's rows", () => {
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
        activeTier="thinking"
        lockedAgent="claude-code"
        onSelect={onSelect}
      />,
    );
    getByText("Haiku 4.5").click();
    expect(onSelect).toHaveBeenCalledWith("claude-code", "fast");
  });

  test("laptop sections render a green dot in their tab label", () => {
    const { getAllByRole } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const tabs = getAllByRole("tab");
    const decopilotTab = tabs.find((t) =>
      t.textContent?.includes("Decopilot"),
    )!;
    const claudeTab = tabs.find((t) => t.textContent?.includes("Claude Code"))!;
    const codexTab = tabs.find((t) => t.textContent?.includes("Codex"))!;

    // Decopilot (cloud) has no green dot
    expect(decopilotTab.querySelector("span.bg-success")).toBeNull();
    // Claude Code (local) has a green dot
    expect(claudeTab.querySelector("span.bg-success")).not.toBeNull();
    // Codex (local) has a green dot
    expect(codexTab.querySelector("span.bg-success")).not.toBeNull();
  });
});
