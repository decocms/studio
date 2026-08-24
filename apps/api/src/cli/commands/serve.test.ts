import { beforeEach, describe, expect, it } from "bun:test";
import { getCliState, resetCliStateForTests } from "../cli-store";
import { interceptConsoleForTui } from "./serve";

describe("interceptConsoleForTui", () => {
  beforeEach(() => {
    resetCliStateForTests();
  });

  it("removes SGR color codes from captured output", () => {
    const restoreConsole = interceptConsoleForTui();

    try {
      console.log("\x1b[32mok\x1b[0m");
    } finally {
      restoreConsole();
    }

    expect(getCliState().logs.map((entry) => entry.rawLine)).toEqual(["ok"]);
  });

  it("removes OSC hyperlinks and CSI erase-line controls", () => {
    const restoreConsole = interceptConsoleForTui();

    try {
      console.log(
        "\x1b]8;;https://example.com\x07Studio\x1b]8;;\x07\x1b[2K ready",
      );
    } finally {
      restoreConsole();
    }

    expect(getCliState().logs.map((entry) => entry.rawLine)).toEqual([
      "Studio ready",
    ]);
  });
});
