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
  test("cloud section header has no success styling (header path)", () => {
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

  test("local CLI section header uses text-success and · on desktop suffix (header path)", () => {
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

  test("hideHeader suppresses the header element entirely", () => {
    const { container } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled={false}
        hideHeader
        onSelect={() => {}}
      />,
    );
    expect(
      container.querySelector("[data-testid=agent-section-header]"),
    ).toBeNull();
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
    getByText("Haiku 4.5").click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("fast");
  });

  test("each row renders icon, label, and description inline", () => {
    const { getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled={false}
        hideHeader
        onSelect={() => {}}
      />,
    );
    // Label and description both visible
    expect(getByText("Haiku 4.5")).toBeInTheDocument();
    expect(getByText("Quicker responses")).toBeInTheDocument();
    expect(getByText("Sonnet 4.6")).toBeInTheDocument();
    expect(getByText("Balanced quality")).toBeInTheDocument();
    expect(getByText("Opus 4.7")).toBeInTheDocument();
    expect(getByText("Deeper reasoning")).toBeInTheDocument();
  });
});
