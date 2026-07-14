import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ModePickerPure, resolveDisplayedAgentMode } from "./mode-picker";

describe("resolveDisplayedAgentMode", () => {
  it("keeps a locked desktop harness visible even when it is unavailable", () => {
    expect(
      resolveDisplayedAgentMode({
        selectedMode: "cloud-decopilot",
        lockedHarness: "claude-code",
        lockedSandbox: "user-desktop",
        isThreadLocked: true,
      }),
    ).toBe("local-claude-code");
  });

  it("keeps the user's selected runtime even when unavailable for unlocked threads", () => {
    expect(
      resolveDisplayedAgentMode({
        selectedMode: "local-codex",
        lockedHarness: null,
        lockedSandbox: null,
        isThreadLocked: false,
      }),
    ).toBe("local-codex");
  });

  it("uses the saved harness as a locked display fallback for unmapped tuples", () => {
    expect(
      resolveDisplayedAgentMode({
        selectedMode: "cloud-decopilot",
        lockedHarness: "codex",
        lockedSandbox: null,
        isThreadLocked: true,
      }),
    ).toBe("local-codex");
  });
});

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
      getByRole("button", { name: "Super Agent on cloud" }),
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
    fireEvent.click(getByRole("button", { name: /Super Agent/i }));

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
    const button = getByRole("button", { name: /Super Agent/i });
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
    expect(button).toHaveAttribute("aria-label", "Super Agent on cloud");
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
    fireEvent.click(getByRole("button", { name: /Super Agent/i }));
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Super Agent/),
      expect.stringMatching(/Super Agent/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("selects unavailable local rows immediately when user desktop is not linked", () => {
    const onSelect = mock(() => {});
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
      />,
    );
    fireEvent.click(getByRole("button", { name: /Super Agent/i }));
    // Local rows are teasers, not omitted — discoverability is the point.
    const items = getAllByRole("menuitem");
    expect(items).toHaveLength(4);

    const claudeCode = getByRole("menuitem", { name: /Claude Code/ });
    expect(claudeCode).not.toHaveAttribute("aria-disabled");
    expect(claudeCode).toHaveTextContent("Desktop not detected");

    // Clicking selects exactly what the user chose; the run path will surface
    // any real connectivity/capability error.
    fireEvent.click(claudeCode);
    expect(onSelect).toHaveBeenCalledWith("local-claude-code");
  });

  it("drops cloud decopilot when agent-sandbox is not configured", () => {
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
    fireEvent.click(getByRole("button", { name: /Super Agent/i }));
    // No agent sandbox (e.g. local/dev mode) → cloud Decopilot can't run and
    // isn't fixable from the menu, so it's omitted. Local runtimes remain.
    const items = getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Runs on your desktop/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("shows unavailable CLIs as selectable rows with a not-detected hint", () => {
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
    fireEvent.click(getByRole("button", { name: /Super Agent/i }));
    for (const name of [/Claude Code/, /Codex/]) {
      const row = getByRole("menuitem", { name });
      expect(row).not.toHaveAttribute("aria-disabled");
      expect(row).toHaveTextContent("Not detected on your desktop");
    }
    expect(
      getByRole("menuitem", { name: /Runs on your desktop/ }),
    ).toHaveTextContent("Super Agent");
  });

  it("keeps the selected checkmark on an unavailable current row", () => {
    const { getByRole } = render(
      <ModePickerPure
        mode="local-codex"
        availability={{
          agentSandbox: true,
          userDesktop: true,
          claudeCode: true,
          codex: false,
        }}
        locked={false}
        onSelect={() => {}}
      />,
    );

    fireEvent.click(getByRole("button", { name: /Codex/i }));

    const row = getByRole("menuitem", { name: /Codex/ });
    expect(row).toHaveTextContent("Not detected on your desktop");
    expect(row.querySelector("svg.text-foreground")).toBeInTheDocument();
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
    fireEvent.click(getByRole("button", { name: /Super Agent/i }));
    fireEvent.click(getByRole("menuitem", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith("local-claude-code");
    expect(queryAllByRole("menuitem")).toHaveLength(0);
  });
});
