import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ModePickerPure } from "./mode-picker";

describe("ModePickerPure", () => {
  it("renders the closed pill with the current mode label", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    expect(getByRole("button", { name: /Cloud/i })).toBeInTheDocument();
  });

  it("renders Claude Code label when active", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="local-claude-code"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    expect(getByRole("button", { name: /Claude Code/i })).toBeInTheDocument();
  });

  it("locked state renders the button disabled (label still in DOM)", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={true}
        onSelect={() => {}}
      />,
    );
    const button = getByRole("button", { name: /Cloud/i });
    expect(button).toBeDisabled();
  });

  it("opens the popover and shows all three rows in order", () => {
    const { getByRole, getAllByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("greys unavailable CLIs but keeps them selectable", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: false, codex: false }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));
    const cc = getByRole("menuitem", { name: /Claude Code/ });
    const codex = getByRole("menuitem", { name: /Codex/ });
    expect(cc).toHaveAttribute("data-available", "false");
    expect(codex).toHaveAttribute("data-available", "false");
    expect(cc).not.toBeDisabled();
    expect(codex).not.toBeDisabled();
  });

  it("calls onSelect with the right mode and closes on click", () => {
    const onSelect = mock(() => {});
    const { getByRole, queryAllByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));
    fireEvent.click(getByRole("menuitem", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith("local-claude-code");
    expect(queryAllByRole("menuitem")).toHaveLength(0);
  });
});
