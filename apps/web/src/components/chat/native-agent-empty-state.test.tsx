import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import type { LocalAgentOption } from "./pills/agent-options";
import {
  NativeAgentTerminalPrompt,
  type NativeAgentTerminalPromptOption,
} from "./native-agent-empty-state";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const OPTIONS: NativeAgentTerminalPromptOption[] = [
  {
    option: "claude-code-desktop",
    label: "Claude Code",
    icon: <svg aria-hidden="true" />,
    availability: "detected",
  },
  {
    option: "codex-desktop",
    label: "Codex",
    icon: <svg aria-hidden="true" />,
    availability: "detected",
  },
  {
    option: "opencode-desktop",
    label: "OpenCode",
    icon: <svg aria-hidden="true" />,
    availability: "try-anyway",
  },
];

function prompt(onSelect: (option: LocalAgentOption) => void) {
  return <NativeAgentTerminalPrompt options={OPTIONS} onSelect={onSelect} />;
}

describe("NativeAgentTerminalPrompt", () => {
  beforeEach(() => localStorage.clear());

  test("keeps the native picker copy and sidebar surface minimal", () => {
    const { getByRole, queryByText } = render(prompt(() => {}));
    const heading = getByRole("heading", { name: "Choose a coding agent" });

    expect(heading.closest("section")).toHaveClass("bg-sidebar");
    expect(queryByText(/which agent/i)).toBeNull();
    expect(queryByText(/local workspace/i)).toBeNull();
    expect(queryByText(/^[123]$/)).toBeNull();
  });

  test("keeps every agent selectable when detection is advisory", () => {
    const selections: LocalAgentOption[] = [];
    const { getAllByRole, getByRole } = render(
      prompt((option) => selections.push(option)),
    );

    expect(getAllByRole("button")).toHaveLength(3);
    fireEvent.click(getByRole("button", { name: /OpenCode/ }));
    expect(selections).toEqual(["opencode-desktop"]);
  });

  test("selects the focused agent with Enter after arrow navigation", () => {
    const selections: LocalAgentOption[] = [];
    const { getAllByRole } = render(
      prompt((option) => selections.push(option)),
    );
    const buttons = getAllByRole("button");

    expect(buttons[0]).toHaveFocus();
    expect(buttons[0]).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(buttons[0] as HTMLButtonElement, { key: "ArrowDown" });
    expect(buttons[1]).toHaveFocus();
    expect(buttons[1]).toHaveAttribute("data-selected", "true");
    expect(buttons[0]).toHaveAttribute("data-selected", "false");
    fireEvent.keyDown(buttons[1] as HTMLButtonElement, { key: "Enter" });

    expect(selections).toEqual(["codex-desktop"]);
  });

  test("wraps focus through the agent rows with arrow keys", () => {
    const { getAllByRole } = render(prompt(() => {}));
    const buttons = getAllByRole("button");

    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0] as HTMLButtonElement, { key: "ArrowUp" });
    expect(buttons[2]).toHaveFocus();
    expect(buttons[2]).toHaveAttribute("data-selected", "true");

    fireEvent.keyDown(buttons[2] as HTMLButtonElement, { key: "ArrowDown" });
    expect(buttons[0]).toHaveFocus();
    expect(buttons[0]).toHaveAttribute("data-selected", "true");
  });
});
