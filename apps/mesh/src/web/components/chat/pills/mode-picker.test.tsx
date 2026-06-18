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
    expect(
      getByRole("button", { name: "Decopilot on cloud" }),
    ).toBeInTheDocument();
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
    expect(
      getByRole("button", { name: "Claude Code on desktop" }),
    ).toBeInTheDocument();
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
    fireEvent.click(getByRole("button", { name: /Decopilot/i }));

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
    const button = getByRole("button", { name: /Decopilot/i });
    expect(button).toBeDisabled();
  });

  it("locked=true gives the button data-testid='mode-picker-locked' and disabled", () => {
    const { getByTestId } = render(
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
    const button = getByTestId("mode-picker-locked");
    expect(button).toBeDisabled();
  });

  it("locked=false gives the button data-testid='mode-picker' and not disabled", () => {
    const { getByTestId } = render(
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
    const button = getByTestId("mode-picker");
    expect(button).not.toBeDisabled();
  });

  it("locked=true with lockedHarness='claude-code' uses harness-specific aria-label", () => {
    const { getByTestId } = render(
      <ModePickerPure
        mode="local-claude-code"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={true}
        lockedHarness="claude-code"
        onSelect={() => {}}
      />,
    );
    const button = getByTestId("mode-picker-locked");
    expect(button).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Claude Code"),
    );
  });

  it("locked=true with lockedHarness=null uses mode text as aria-label", () => {
    const { getByTestId } = render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: true,
        }}
        locked={true}
        lockedHarness={null}
        onSelect={() => {}}
      />,
    );
    const button = getByTestId("mode-picker-locked");
    expect(button).toHaveAttribute("aria-label", "Decopilot on cloud");
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
    fireEvent.click(getByRole("button", { name: /Decopilot/i }));
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("shows local rows as disabled connect-desktop teasers when user desktop is not linked", () => {
    const onSelect = mock(() => {});
    const onConnectDesktop = mock(() => {});
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
        onSelect={onSelect}
        onConnectDesktop={onConnectDesktop}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Decopilot/i }));
    // Local rows are teasers, not omitted — discoverability is the point.
    const items = getAllByRole("menuitem");
    expect(items).toHaveLength(4);

    const claudeCode = getByRole("menuitem", { name: /Claude Code/ });
    expect(claudeCode).toHaveAttribute("aria-disabled", "true");
    expect(claudeCode).toHaveTextContent("Connect your desktop to enable");

    // Clicking a teaser routes to the connect flow, never selects the mode.
    fireEvent.click(claudeCode);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onConnectDesktop).toHaveBeenCalledTimes(1);
  });

  it("omits cloud decopilot when agent-sandbox is not configured", () => {
    const { getByRole, getAllByRole, queryByRole } = render(
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
    // Cloud row is gone (operator decision, not user-actionable); local rows
    // all render — available Decopilot plus the two CLI teasers.
    expect(queryByRole("menuitem", { name: /agent sandbox/i })).toBeNull();
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("shows unavailable CLIs as disabled rows with a not-detected hint", () => {
    const { getByRole } = render(
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
    fireEvent.click(getByRole("button", { name: /Decopilot/i }));
    for (const name of [/Claude Code/, /Codex/]) {
      const row = getByRole("menuitem", { name });
      expect(row).toHaveAttribute("aria-disabled", "true");
      expect(row).toHaveTextContent("Not detected on your desktop");
    }
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
    fireEvent.click(getByRole("button", { name: /Decopilot/i }));
    fireEvent.click(getByRole("menuitem", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith("local-claude-code");
    expect(queryAllByRole("menuitem")).toHaveLength(0);
  });
});
