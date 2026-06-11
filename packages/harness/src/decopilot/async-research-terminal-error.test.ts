import { describe, expect, it } from "bun:test";
import { AsyncResearchTerminalError } from "./async-research-terminal-error";

describe("AsyncResearchTerminalError (harness leaf)", () => {
  it("is an Error subclass carrying its message", () => {
    const e = new AsyncResearchTerminalError("job failed");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("job failed");
  });
});
