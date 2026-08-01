import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  createTerminalParserCapabilityQueryAuthority,
  createTerminalPixelSizeQueryScanner,
  cssColorToOscRgb,
  DEFAULT_DA1_RESPONSE,
  installTerminalCapabilityReplyHandlers,
  terminalOscColorQueryReplies,
  terminalOscColorQuerySlotsForBody,
  terminalPixelSizeReply,
  type TerminalPixelSizeQuery,
} from "./terminal-capability-replies";

const bytes = (value: string) => new TextEncoder().encode(value);
const writeTerminal = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

describe("native terminal capability replies", () => {
  test("converts terminal theme colors to OSC rgb words", () => {
    expect(cssColorToOscRgb("#2e3434")).toBe("rgb:2e2e/3434/3434");
    expect(cssColorToOscRgb("rgb(245 245 244 / 92%)")).toBe(
      "rgb:f5f5/f5f5/f4f4",
    );
    expect(cssColorToOscRgb("rgba(17, 34, 51, 0.5)")).toBe(
      "rgb:1111/2222/3333",
    );
    expect(cssColorToOscRgb("oklch(0 0 0)")).toBe("rgb:0000/0000/0000");
    expect(cssColorToOscRgb("oklch(100% 0 0)")).toBe("rgb:ffff/ffff/ffff");
    expect(cssColorToOscRgb("not-a-color")).toBeNull();
  });

  test("builds single and combined OSC 10/11 replies for Studio oklch themes", () => {
    const theme = {
      foreground: "oklch(0.96 0.005 60)",
      background: "oklch(0.155 0.005 60)",
    };
    expect(terminalOscColorQuerySlotsForBody(10, "?")).toEqual([10]);
    expect(terminalOscColorQuerySlotsForBody(10, "?;?")).toEqual([10, 11]);
    expect(terminalOscColorQuerySlotsForBody(11, "?")).toEqual([11]);
    expect(terminalOscColorQuerySlotsForBody(11, "?;?")).toBeNull();

    const replies = terminalOscColorQueryReplies(theme, [10, 11]);
    expect(replies).toHaveLength(2);
    expect(replies?.[0]?.startsWith("\x1b]10;rgb:")).toBeTrue();
    expect(replies?.[0]?.endsWith("\x1b\\")).toBeTrue();
    expect(replies?.[1]?.startsWith("\x1b]11;rgb:")).toBeTrue();
    expect(replies?.[1]?.endsWith("\x1b\\")).toBeTrue();
    expect(
      terminalOscColorQueryReplies(
        { foreground: theme.foreground, background: "invalid" },
        [10, 11],
      ),
    ).toBeNull();
  });

  test("answers live OSC queries through xterm and consumes replayed queries", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      theme: {
        foreground: "oklch(0.96 0.005 60)",
        background: "oklch(0.155 0.005 60)",
      },
    });
    terminal.open(element);
    const replies: string[] = [];
    let repliesAllowed = true;
    const authority = createTerminalParserCapabilityQueryAuthority();
    const handlers = installTerminalCapabilityReplyHandlers({
      terminal,
      parser: terminal.parser,
      sendInput: (reply) => replies.push(reply),
      takeReplyAuthority: authority.takeReplyAuthority,
    });

    try {
      // xterm normalizes the OSC body before calling registered handlers. The
      // raw authority scanner must make the identical normalization decision.
      const liveQuery = "\x1b]10;  ?;?  \x1b\\";
      authority.observe(bytes(liveQuery), repliesAllowed);
      await writeTerminal(terminal, liveQuery);
      expect(replies).toHaveLength(2);

      repliesAllowed = false;
      const replayedQuery = "\x1b]11;?\x07";
      authority.observe(bytes(replayedQuery), repliesAllowed);
      await writeTerminal(terminal, replayedQuery);
      expect(replies).toHaveLength(2);
    } finally {
      handlers.dispose();
      terminal.dispose();
    }
  });

  test("answers primary DA1 empty/zero queries and consumes replayed DA1", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const terminal = new Terminal({ allowProposedApi: true });
    terminal.open(element);
    const replies: string[] = [];
    let repliesAllowed = true;
    const authority = createTerminalParserCapabilityQueryAuthority();
    const handlers = installTerminalCapabilityReplyHandlers({
      terminal,
      parser: terminal.parser,
      sendInput: (reply) => replies.push(reply),
      takeReplyAuthority: authority.takeReplyAuthority,
    });

    try {
      const liveQueries = "\x1b[c\x1b[0c\x1b[1c";
      authority.observe(bytes(liveQueries), repliesAllowed);
      await writeTerminal(terminal, liveQueries);
      expect(replies).toEqual([DEFAULT_DA1_RESPONSE, DEFAULT_DA1_RESPONSE]);

      repliesAllowed = false;
      const replayedQueries = "\x1b[c\x1b[0c";
      authority.observe(bytes(replayedQueries), repliesAllowed);
      await writeTerminal(terminal, replayedQueries);
      expect(replies).toEqual([DEFAULT_DA1_RESPONSE, DEFAULT_DA1_RESPONSE]);
    } finally {
      handlers.dispose();
      terminal.dispose();
    }
  });

  test("ANDs OSC and DA1 authority across replay-to-live frame boundaries", () => {
    const authority = createTerminalParserCapabilityQueryAuthority();

    authority.observe(bytes("\x1b]10;"), false);
    authority.observe(bytes("?\x1b\\"), true);
    expect(
      authority.takeReplyAuthority({
        kind: "osc-color",
        slot: 10,
        body: "?",
      }),
    ).toBeFalse();

    authority.observe(bytes("\x1b["), false);
    authority.observe(bytes("0c"), true);
    expect(authority.takeReplyAuthority({ kind: "da1" })).toBeFalse();

    authority.observe(bytes("\x1b]11;?\x07\x1b[c"), true);
    expect(
      authority.takeReplyAuthority({
        kind: "osc-color",
        slot: 11,
        body: "?",
      }),
    ).toBeTrue();
    expect(authority.takeReplyAuthority({ kind: "da1" })).toBeTrue();
  });

  test("does not consume queued authority for a mismatched parser query", () => {
    const authority = createTerminalParserCapabilityQueryAuthority();

    authority.observe(bytes("\x1b]10;  ?;?  \x1b\\"), true);
    expect(authority.takeReplyAuthority({ kind: "da1" })).toBeFalse();
    expect(
      authority.takeReplyAuthority({
        kind: "osc-color",
        slot: 10,
        body: "?",
      }),
    ).toBeFalse();
    expect(
      authority.takeReplyAuthority({
        kind: "osc-color",
        slot: 10,
        body: "?;?",
      }),
    ).toBeTrue();

    authority.observe(bytes("\x1b[c"), true);
    expect(
      authority.takeReplyAuthority({
        kind: "osc-color",
        slot: 11,
        body: "?",
      }),
    ).toBeFalse();
    expect(authority.takeReplyAuthority({ kind: "da1" })).toBeTrue();
  });

  test("keeps split replay-to-live OSC and DA1 queries inert in xterm", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const terminal = new Terminal({
      allowProposedApi: true,
      theme: { foreground: "#ffffff", background: "#000000" },
    });
    terminal.open(element);
    const replies: string[] = [];
    const authority = createTerminalParserCapabilityQueryAuthority();
    const handlers = installTerminalCapabilityReplyHandlers({
      terminal,
      parser: terminal.parser,
      sendInput: (reply) => replies.push(reply),
      takeReplyAuthority: authority.takeReplyAuthority,
    });

    const write = async (data: string, repliesAllowed: boolean) => {
      authority.observe(bytes(data), repliesAllowed);
      await writeTerminal(terminal, data);
    };

    try {
      await write("\x1b]10;", false);
      await write("?\x1b\\", true);
      await write("\x1b[", false);
      await write("0c", true);
      expect(replies).toEqual([]);

      await write("\x1b]11;?\x07\x1b[c", true);
      expect(replies).toEqual([
        "\x1b]11;rgb:0000/0000/0000\x1b\\",
        DEFAULT_DA1_RESPONSE,
      ]);
    } finally {
      handlers.dispose();
      terminal.dispose();
    }
  });

  test("gates every xterm-native reply family by whole-query authority", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      theme: {
        background: "#000000",
        cursor: "#ffffff",
        foreground: "#ffffff",
        red: "#ff0000",
      },
      windowOptions: { getWinSizeChars: true },
    });
    terminal.open(element);
    const authority = createTerminalParserCapabilityQueryAuthority();
    const emitted: string[] = [];
    const forwarded: string[] = [];
    let writing = false;
    let currentFrameRepliesAllowed = false;
    const inputSubscription = terminal.onData((data) => {
      emitted.push(data);
      if (!writing) {
        forwarded.push(data);
        return;
      }
      const replyAuthority = authority.takeNativeReplyAuthority(data);
      if (replyAuthority === false) return;
      if (replyAuthority === null && !currentFrameRepliesAllowed) return;
      forwarded.push(data);
    });
    const write = async (data: string, repliesAllowed: boolean) => {
      writing = true;
      currentFrameRepliesAllowed = repliesAllowed;
      authority.observe(bytes(data), repliesAllowed);
      await writeTerminal(terminal, data);
      currentFrameRepliesAllowed = false;
      writing = false;
    };
    const queryFamilies = [
      ["DA1", "\x1b[c"],
      ["DA2", "\x1b[>c"],
      ["DSR", "\x1b[5n"],
      ["CPR", "\x1b[6n"],
      ["private CPR", "\x1b[?6n"],
      ["ANSI DECRQM", "\x1b[4$p"],
      ["private DECRQM", "\x1b[?2026$p"],
      ["window size", "\x1b[18t"],
      ["indexed OSC color", "\x1b]4;1;?\x1b\\"],
      ["foreground/background OSC colors", "\x1b]10;?;?\x1b\\"],
      ["cursor OSC color", "\x1b]12;?\x1b\\"],
      ["DECRQSS", "\x1bP$qm\x1b\\"],
    ] as const;

    try {
      for (const [name, query] of queryFamilies) {
        authority.reset();
        emitted.length = 0;
        forwarded.length = 0;
        await write(query.slice(0, 2), false);
        await write(query.slice(2), true);
        expect(
          emitted.length,
          `${name} should make xterm reply`,
        ).toBeGreaterThan(0);
        expect(forwarded, `${name} replay-to-live split`).toEqual([]);

        authority.reset();
        emitted.length = 0;
        forwarded.length = 0;
        await write(query, true);
        expect(emitted.length, `${name} live query`).toBeGreaterThan(0);
        expect(forwarded, `${name} live query`).toEqual(emitted);

        authority.reset();
        emitted.length = 0;
        forwarded.length = 0;
        await write(query, false);
        expect(emitted.length, `${name} replayed query`).toBeGreaterThan(0);
        expect(forwarded, `${name} replayed query`).toEqual([]);
      }
    } finally {
      inputSubscription.dispose();
      terminal.dispose();
    }
  });

  test("carries authority for xterm extension reply families", () => {
    const extensions = [
      ["\x1b[>q", "\x1bP>|xterm.js(6.0.0)\x1b\\"],
      ["\x1b[?u", "\x1b[?0u"],
      ["\x1bP+q544e\x1b\\", "\x1bP1+r544e=787465726d\x1b\\"],
    ] as const;

    for (const [query, reply] of extensions) {
      const authority = createTerminalParserCapabilityQueryAuthority();
      authority.observe(bytes(query.slice(0, 2)), false);
      authority.observe(bytes(query.slice(2)), true);
      expect(authority.takeNativeReplyAuthority(reply)).toBeFalse();

      authority.observe(bytes(query), true);
      expect(authority.takeNativeReplyAuthority(reply)).toBeTrue();
    }
  });

  test("reports window and cell pixel sizes from renderer geometry", () => {
    const geometry = { cols: 100, rows: 40, width: 900, height: 720 };
    expect(terminalPixelSizeReply(14, geometry)).toBe("\x1b[4;720;900t");
    expect(terminalPixelSizeReply(16, geometry)).toBe("\x1b[6;18;9t");
    expect(terminalPixelSizeReply(14, { ...geometry, width: 0 })).toBeNull();
  });

  test("recognizes pixel queries split at every byte boundary", () => {
    for (const query of [14, 16] as const) {
      const sequence = `\x1b[${query}t`;
      for (let split = 0; split <= sequence.length; split++) {
        const observed: Array<[TerminalPixelSizeQuery, boolean]> = [];
        const scanner = createTerminalPixelSizeQueryScanner((...entry) => {
          observed.push(entry);
        });
        scanner.observe(bytes(sequence.slice(0, split)), true);
        scanner.observe(bytes(sequence.slice(split)), true);
        expect(observed).toEqual([[query, true]]);
      }
    }
  });

  test("carries reply authority across chunks and clears partials on reset", () => {
    const observed: Array<[TerminalPixelSizeQuery, boolean]> = [];
    const scanner = createTerminalPixelSizeQueryScanner((...entry) => {
      observed.push(entry);
    });

    scanner.observe(bytes("noise\x1b["), false);
    scanner.observe(bytes("14t"), true);
    expect(observed).toEqual([[14, false]]);

    scanner.observe(bytes("\x1b[1"), true);
    scanner.reset();
    scanner.observe(bytes("6t"), true);
    expect(observed).toEqual([[14, false]]);

    scanner.observe(bytes("\x1b[14;1t\x1b[16t"), true);
    expect(observed).toEqual([
      [14, false],
      [16, true],
    ]);
  });
});
