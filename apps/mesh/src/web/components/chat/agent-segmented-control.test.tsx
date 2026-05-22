import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSegmentedControlPure } from "./agent-segmented-control";
import { getAgentSections } from "./select-model/agent-models";

const ALL = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

describe("AgentSegmentedControlPure", () => {
  test("renders one button per section", () => {
    const { getAllByRole } = render(
      <AgentSegmentedControlPure
        sections={ALL}
        activeAgent="decopilot"
        onSelect={() => {}}
      />,
    );
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.textContent).toContain("Decopilot");
    expect(buttons[1]?.textContent).toContain("Claude Code");
    expect(buttons[2]?.textContent).toContain("Codex");
  });

  test("active segment has aria-pressed=true and others have aria-pressed=false", () => {
    const { getAllByRole } = render(
      <AgentSegmentedControlPure
        sections={ALL}
        activeAgent="claude-code"
        onSelect={() => {}}
      />,
    );
    const buttons = getAllByRole("button");
    const decopilot = buttons.find((b) =>
      b.textContent?.includes("Decopilot"),
    )!;
    const claude = buttons.find((b) => b.textContent?.includes("Claude Code"))!;
    const codex = buttons.find((b) => b.textContent?.includes("Codex"))!;
    expect(decopilot.getAttribute("aria-pressed")).toBe("false");
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    expect(codex.getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking a segment fires onSelect with that kind", () => {
    const onSelect = mock((_k: "decopilot" | "claude-code" | "codex") => {});
    const { getAllByRole } = render(
      <AgentSegmentedControlPure
        sections={ALL}
        activeAgent="decopilot"
        onSelect={onSelect}
      />,
    );
    const codex = getAllByRole("button").find((b) =>
      b.textContent?.includes("Codex"),
    )!;
    codex.click();
    expect(onSelect).toHaveBeenCalledWith("codex");
  });

  test("laptop sections render the local indicator and sr-only 'on desktop' text", () => {
    const { getAllByRole, getAllByTestId } = render(
      <AgentSegmentedControlPure
        sections={ALL}
        activeAgent="decopilot"
        onSelect={() => {}}
      />,
    );
    const buttons = getAllByRole("button");
    const decopilot = buttons.find((b) =>
      b.textContent?.includes("Decopilot"),
    )!;
    const claude = buttons.find((b) => b.textContent?.includes("Claude Code"))!;
    const codex = buttons.find((b) => b.textContent?.includes("Codex"))!;

    // Decopilot (cloud) — no local indicator.
    expect(decopilot.querySelector("[data-testid=local-indicator]")).toBeNull();
    // Both CLI sections — local indicator present.
    expect(
      claude.querySelector("[data-testid=local-indicator]"),
    ).not.toBeNull();
    expect(codex.querySelector("[data-testid=local-indicator]")).not.toBeNull();
    // sr-only "on desktop" mirrors the tabs.
    expect(claude.textContent).toContain("on desktop");
    expect(codex.textContent).toContain("on desktop");

    // And there are exactly two local indicators across the whole control.
    expect(getAllByTestId("local-indicator")).toHaveLength(2);
  });

  test("no segment is active when activeAgent is null", () => {
    const { getAllByRole } = render(
      <AgentSegmentedControlPure
        sections={ALL}
        activeAgent={null}
        onSelect={() => {}}
      />,
    );
    const buttons = getAllByRole("button");
    expect(
      buttons.every((b) => b.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });
});
