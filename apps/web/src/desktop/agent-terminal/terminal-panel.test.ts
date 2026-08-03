import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  hasVisibleTerminalContent,
  isOpenableTerminalLink,
  nativeTerminalPanelSurface,
  shouldForwardTerminalData,
  shouldRevealTerminal,
  terminalPulsePhase,
} from "./terminal-panel";

const writeTerminal = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

describe("native terminal loading visibility", () => {
  test("keeps unsupported locked chats out of the terminal surface", () => {
    expect(
      nativeTerminalPanelSurface({
        isThreadLocked: true,
        lockedHarness: "decopilot",
        hasSession: false,
        physicalState: null,
      }),
    ).toBe("unsupported");
    expect(
      nativeTerminalPanelSurface({
        isThreadLocked: true,
        lockedHarness: null,
        hasSession: false,
        physicalState: null,
      }),
    ).toBe("unsupported");
  });

  test("renders only supported locked chats and active sessions as terminals", () => {
    for (const lockedHarness of ["claude-code", "codex", "opencode"]) {
      expect(
        nativeTerminalPanelSurface({
          isThreadLocked: true,
          lockedHarness,
          hasSession: false,
          physicalState: null,
        }),
      ).toBe("terminal");
    }

    expect(
      nativeTerminalPanelSurface({
        isThreadLocked: false,
        lockedHarness: null,
        hasSession: true,
        physicalState: "running",
      }),
    ).toBe("terminal");
    expect(
      nativeTerminalPanelSurface({
        isThreadLocked: false,
        lockedHarness: null,
        hasSession: false,
        physicalState: "starting",
      }),
    ).toBe("terminal");
    expect(
      nativeTerminalPanelSurface({
        isThreadLocked: false,
        lockedHarness: null,
        hasSession: false,
        physicalState: null,
      }),
    ).toBe("picker");
  });

  test("allows only links that the native OS opener can route", () => {
    expect(isOpenableTerminalLink("https://example.com/docs")).toBeTrue();
    expect(isOpenableTerminalLink("http://localhost:4000/chat")).toBeTrue();
    expect(isOpenableTerminalLink("http://127.0.0.1:4000/chat")).toBeTrue();
    expect(isOpenableTerminalLink("vscode://file/tmp/example.ts:4")).toBeTrue();
    expect(isOpenableTerminalLink("cursor://file/tmp/example.ts:4")).toBeTrue();

    expect(isOpenableTerminalLink("http://example.com/docs")).toBeFalse();
    expect(isOpenableTerminalLink("javascript:alert(1)")).toBeFalse();
    expect(isOpenableTerminalLink("data:text/html,hello")).toBeFalse();
    expect(isOpenableTerminalLink("file:///tmp/example.ts")).toBeFalse();
    expect(isOpenableTerminalLink("/tmp/example.ts")).toBeFalse();
    expect(isOpenableTerminalLink("not a link")).toBeFalse();
  });

  test("forwards user input while rejecting recognized replay replies", () => {
    expect(shouldForwardTerminalData(null)).toBeTrue();
    expect(shouldForwardTerminalData(true)).toBeTrue();
    expect(shouldForwardTerminalData(false)).toBeFalse();
  });

  test("derives the terminal pulse from authoritative lifecycle state", () => {
    expect(terminalPulsePhase("connecting", "starting")).toBe("starting");
    expect(terminalPulsePhase("connected", "running")).toBe("waiting-output");
    expect(terminalPulsePhase("connecting", "running")).toBe("reconnecting");
    expect(terminalPulsePhase("disconnected", "running")).toBe("reconnecting");
    expect(terminalPulsePhase("reconnecting", "running")).toBe("reconnecting");
  });

  test("reveals on meaningful paint or the bounded post-output fallback", () => {
    expect(shouldRevealTerminal(false, false, false)).toBeFalse();
    expect(shouldRevealTerminal(false, false, true)).toBeFalse();
    expect(shouldRevealTerminal(true, false, false)).toBeFalse();
    expect(shouldRevealTerminal(true, true, false)).toBeTrue();
    expect(shouldRevealTerminal(true, false, true)).toBeTrue();
  });

  test("waits for non-whitespace content painted in the visible buffer", async () => {
    const terminal = new Terminal({ cols: 20, rows: 4 });

    try {
      expect(hasVisibleTerminalContent(terminal)).toBeFalse();

      await writeTerminal(terminal, " \t\r\n\x1b[?25l");
      expect(hasVisibleTerminalContent(terminal)).toBeFalse();

      await writeTerminal(terminal, "Claude Code");
      expect(hasVisibleTerminalContent(terminal)).toBeTrue();

      await writeTerminal(terminal, "\x1b[2J\x1b[H");
      expect(hasVisibleTerminalContent(terminal)).toBeFalse();
    } finally {
      terminal.dispose();
    }
  });
});
