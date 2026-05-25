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

describe("AgentModelPopover", () => {
  test("renders one AgentSection per item", () => {
    const { getAllByTestId } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    expect(getAllByTestId("agent-section")).toHaveLength(3);
  });

  test("when lockedAgent is set, only the matching section is enabled", () => {
    const { getAllByTestId } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent="claude-code"
        onSelect={() => {}}
      />,
    );
    const sections = getAllByTestId("agent-section");
    const disabled = sections.filter(
      (s) => s.getAttribute("aria-disabled") === "true",
    );
    expect(disabled).toHaveLength(2);
  });

  test("row click in a section calls onSelect with (kind, tier)", () => {
    const onSelect = mock(
      (
        _k: "decopilot" | "claude-code" | "codex",
        _t: "fast" | "smart" | "thinking",
      ) => {},
    );
    const { getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={onSelect}
      />,
    );
    getByText("Haiku 4.5").click();
    expect(onSelect).toHaveBeenCalledWith("claude-code", "fast");
  });

  test("locked non-active section does NOT call onSelect when its rows are clicked", () => {
    const onSelect = mock(() => {});
    const { getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent="claude-code"
        onSelect={onSelect}
      />,
    );
    // Fast row inside the locked Decopilot section
    getByText("Fast").click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
