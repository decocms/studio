import { expect, it } from "bun:test";
import { getCliState, resetCliStateForTests } from "../cli-store";
import { interceptConsoleForTui } from "./serve";

it("interceptConsoleForTui removes SGR, OSC, and CSI controls", () => {
  resetCliStateForTests();
  const restoreConsole = interceptConsoleForTui();

  try {
    console.log(
      "\x1b[32m\x1b]8;;https://example.com\x07Studio\x1b]8;;\x07\x1b[2K ready\x1b[0m",
    );
  } finally {
    restoreConsole();
  }

  expect(getCliState().logs[0]?.rawLine).toBe("Studio ready");
});
