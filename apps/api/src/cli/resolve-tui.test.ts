import { describe, expect, it } from "bun:test";
import { resolveTui } from "./resolve-tui";

describe("resolveTui", () => {
  it("disables the TUI when --no-tui is passed, even on a TTY", () => {
    expect(resolveTui({ noTui: true, isTty: true })).toBe(false);
  });

  it("disables the TUI on a non-TTY even without --no-tui", () => {
    expect(resolveTui({ noTui: false, isTty: false })).toBe(false);
  });

  it("enables the TUI on a TTY without --no-tui", () => {
    expect(resolveTui({ noTui: false, isTty: true })).toBe(true);
  });
});
