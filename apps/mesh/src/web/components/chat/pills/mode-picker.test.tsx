import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ModePickerPure } from "./mode-picker";

describe("ModePickerPure", () => {
  it("renders the closed pill with the current mode label", () => {
    const { getByRole, getByAltText } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    expect(getByRole("button", { name: /Cloud/i })).toBeInTheDocument();
    expect(getByAltText("Decopilot")).toBeInTheDocument();
  });

  it("renders Claude Code label when active", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="local-claude-code"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    expect(getByRole("button", { name: /Claude Code/i })).toBeInTheDocument();
  });

  it("marks the selected local preview as green without marking the popover row", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="local-codex"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    const trigger = getByRole("button", { name: /Codex/i });
    expect(trigger).toHaveClass("text-success");

    fireEvent.click(trigger);
    expect(getByRole("menuitem", { name: /Codex/ })).not.toHaveClass(
      "text-success",
    );
  });

  it("marks the local section header as green with a desktop icon", () => {
    const { getByRole, getByTestId } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));

    const localHeader = getByTestId("local-section-header");
    expect(localHeader).toHaveClass("text-success");
    expect(localHeader).toHaveClass("bg-success/10");
    expect(localHeader).toHaveClass("gap-2");
    expect(getByTestId("local-section-desktop-icon")).toBeInTheDocument();

    const localDecopilot = getByRole("menuitem", {
      name: /Runs on your desktop/,
    });
    expect(localDecopilot).not.toHaveClass("text-success");
    expect(localDecopilot.querySelector(".text-xs")).not.toHaveClass(
      "text-success",
    );
  });

  it("locked state renders the button disabled (label still in DOM)", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={true}
        onSelect={() => {}}
      />,
    );
    const button = getByRole("button", { name: /Cloud/i });
    expect(button).toBeDisabled();
  });

  it("opens the popover and shows stitched rows in order", () => {
    const { getByRole, getAllByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("omits local rows when user desktop is not linked", () => {
    const { getByRole, getAllByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: false,
          claudeCode: true,
          codex: true,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
    ]);
  });

  it("omits cloud decopilot when agent-sandbox is not configured", () => {
    const { getByRole, getAllByRole } = render(
      <ModePickerPure
        mode="local-decopilot"
        availability={{
          agentSandbox: false,
          userDesktop: true,
          claudeCode: false,
          codex: false,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Decopilot/i }));
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
    ]);
  });

  it("omits unavailable CLIs", () => {
    const { getByRole, queryByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: false,
          codex: false,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Cloud/i }));
    expect(queryByRole("menuitem", { name: /Claude Code/ })).toBeNull();
    expect(queryByRole("menuitem", { name: /Codex/ })).toBeNull();
    expect(
      getByRole("menuitem", { name: /Runs on your desktop/ }),
    ).toHaveTextContent("Decopilot");
  });

  it("calls onSelect with the right mode and closes on click", () => {
    const onSelect = mock(() => {});
    const { getByRole, queryAllByRole } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
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
