import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentHarnessTriggerPure } from "./agent-harness-trigger";
import { getAgentSections } from "./select-model/agent-models";

const ALL = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

describe("AgentHarnessTriggerPure", () => {
  test("closed pill shows the active section's title", () => {
    const { getByRole } = render(
      <AgentHarnessTriggerPure
        sections={ALL}
        activeAgent="claude-code"
        onSelect={() => {}}
      />,
    );
    const pill = getByRole("button");
    expect(pill.textContent).toContain("Claude Code");
  });

  test("local active agent renders the green dot on the pill", () => {
    const { getByRole } = render(
      <AgentHarnessTriggerPure
        sections={ALL}
        activeAgent="codex"
        onSelect={() => {}}
      />,
    );
    const pill = getByRole("button");
    expect(
      pill.querySelector("[data-testid=harness-local-indicator]"),
    ).not.toBeNull();
  });

  test("cloud active agent does not render the green dot on the pill", () => {
    const { getByRole } = render(
      <AgentHarnessTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        onSelect={() => {}}
      />,
    );
    const pill = getByRole("button");
    expect(
      pill.querySelector("[data-testid=harness-local-indicator]"),
    ).toBeNull();
  });

  test("opens popover and renders one row per section", () => {
    const { getByRole, getAllByRole } = render(
      <AgentHarnessTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        onSelect={() => {}}
      />,
    );
    const pill = getByRole("button");
    fireEvent.click(pill);
    const rows = getAllByRole("button").filter((b) => b !== pill);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Decopilot");
    expect(rows[1]?.textContent).toContain("Claude Code");
    expect(rows[2]?.textContent).toContain("Codex");
  });

  test("clicking a row fires onSelect with that kind", () => {
    const onSelect = mock((_k: "decopilot" | "claude-code" | "codex") => {});
    const { getByRole, getAllByRole } = render(
      <AgentHarnessTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        onSelect={onSelect}
      />,
    );
    const pill = getByRole("button");
    fireEvent.click(pill);
    const codex = getAllByRole("button").find(
      (b) => b !== pill && b.textContent?.includes("Codex"),
    )!;
    fireEvent.click(codex);
    expect(onSelect).toHaveBeenCalledWith("codex");
  });

  test("active row has aria-pressed=true and others have aria-pressed=false", () => {
    const { getByRole, getAllByRole } = render(
      <AgentHarnessTriggerPure
        sections={ALL}
        activeAgent="claude-code"
        onSelect={() => {}}
      />,
    );
    const pill = getByRole("button");
    fireEvent.click(pill);
    const rows = getAllByRole("button").filter((b) => b !== pill);
    const claude = rows.find((b) => b.textContent?.includes("Claude Code"))!;
    const decopilot = rows.find((b) => b.textContent?.includes("Decopilot"))!;
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    expect(decopilot.getAttribute("aria-pressed")).toBe("false");
  });
});
