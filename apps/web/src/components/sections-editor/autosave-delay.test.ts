import { describe, expect, it } from "bun:test";
import { autosaveDelay } from "./autosave-delay";

describe("autosaveDelay", () => {
  it("keeps a v7 site's 700 ms", () => {
    expect(autosaveDelay(false)).toBe(700);
  });

  it("waits 1 s on a v8 site", () => {
    expect(autosaveDelay(true)).toBe(1000);
  });
});
