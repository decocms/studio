import { describe, expect, it } from "bun:test";
import { keyToIntent } from "./link-keymap";

describe("keyToIntent (no pending confirm)", () => {
  it("maps arrows and j/k to move", () => {
    expect(keyToIntent("", { upArrow: true }, false)).toEqual({
      type: "move",
      delta: -1,
    });
    expect(keyToIntent("", { downArrow: true }, false)).toEqual({
      type: "move",
      delta: 1,
    });
    expect(keyToIntent("k", {}, false)).toEqual({ type: "move", delta: -1 });
    expect(keyToIntent("j", {}, false)).toEqual({ type: "move", delta: 1 });
  });
  it("maps action keys", () => {
    expect(keyToIntent("s", {}, false)).toEqual({ type: "stop" });
    expect(keyToIntent("d", {}, false)).toEqual({ type: "delete" });
    expect(keyToIntent("o", {}, false)).toEqual({ type: "open" });
    expect(keyToIntent("q", {}, false)).toEqual({ type: "quit" });
    expect(keyToIntent("c", { ctrl: true }, false)).toEqual({ type: "quit" });
  });
  it("returns null for unmapped keys", () => {
    expect(keyToIntent("x", {}, false)).toBeNull();
  });
});

describe("keyToIntent (pending confirm)", () => {
  it("only y confirms; everything else cancels", () => {
    expect(keyToIntent("y", {}, true)).toEqual({ type: "confirmYes" });
    expect(keyToIntent("Y", {}, true)).toEqual({ type: "confirmYes" });
    expect(keyToIntent("n", {}, true)).toEqual({ type: "confirmNo" });
    expect(keyToIntent("d", {}, true)).toEqual({ type: "confirmNo" });
  });
});
