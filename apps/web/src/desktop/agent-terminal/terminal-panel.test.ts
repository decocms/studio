import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  hasVisibleTerminalContent,
  shouldRevealTerminal,
} from "./terminal-panel";

const writeTerminal = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

describe("native terminal loading visibility", () => {
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
