import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSection } from "./agent-section";
import { getAgentSections } from "./agent-models";

const SECTIONS = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

const decopilot = SECTIONS.find((s) => s.kind === "decopilot")!;
const claude = SECTIONS.find((s) => s.kind === "claude-code")!;

describe("AgentSection", () => {
  test("cloud section header has no success styling", () => {
    const { container } = render(
      <AgentSection
        section={decopilot}
        selectedTier="smart"
        disabled={false}
        onSelect={() => {}}
      />,
    );
    const header = container.querySelector(
      "[data-testid=agent-section-header]",
    );
    expect(header?.className).not.toMatch(/text-success/);
  });

  test("local CLI section header uses text-success and · on desktop suffix", () => {
    const { container, getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled={false}
        onSelect={() => {}}
      />,
    );
    const header = container.querySelector(
      "[data-testid=agent-section-header]",
    );
    expect(header?.className).toMatch(/text-success/);
    expect(getByText(/Claude Code · on desktop/)).toBeInTheDocument();
  });

  test("disabled section sets aria-disabled and stops onSelect from firing", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled
        onSelect={onSelect}
      />,
    );
    const wrapper = container.querySelector("[data-testid=agent-section]");
    expect(wrapper?.getAttribute("aria-disabled")).toBe("true");
    const rows = container.querySelectorAll("button");
    rows.forEach((b) => b.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("enabled row click fires onSelect with the row's tier", () => {
    const onSelect = mock((_tier: "fast" | "smart" | "thinking") => {});
    const { getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled={false}
        onSelect={onSelect}
      />,
    );
    getByText("Haiku").click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("fast");
  });

  test("selected row marks itself with the On indicator", () => {
    const { getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="thinking"
        disabled={false}
        onSelect={() => {}}
      />,
    );
    expect(getByText("On")).toBeInTheDocument();
  });
});
