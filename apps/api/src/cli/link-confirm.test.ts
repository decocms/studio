import { describe, expect, it } from "bun:test";
import { formatConfirm } from "./link-confirm";

describe("formatConfirm", () => {
  it("plain prompt when clean and merged", () => {
    expect(
      formatConfirm({
        handle: "h",
        branch: "feat",
        dirtyCount: 0,
        merged: true,
      }),
    ).toBe("Delete feat? (y/n)");
  });
  it("warns about uncommitted files (singular/plural)", () => {
    expect(
      formatConfirm({
        handle: "h",
        branch: "feat",
        dirtyCount: 1,
        merged: true,
      }),
    ).toBe("⚠ 1 uncommitted file — delete feat? (y/n)");
    expect(
      formatConfirm({
        handle: "h",
        branch: "feat",
        dirtyCount: 3,
        merged: true,
      }),
    ).toBe("⚠ 3 uncommitted files — delete feat? (y/n)");
  });
  it("warns about an unmerged branch", () => {
    expect(
      formatConfirm({
        handle: "h",
        branch: "feat",
        dirtyCount: 0,
        merged: false,
      }),
    ).toBe("⚠ branch not merged — delete feat? (y/n)");
  });
  it("combines warnings and falls back to handle when branch is null", () => {
    expect(
      formatConfirm({
        handle: "h",
        branch: null,
        dirtyCount: 2,
        merged: false,
      }),
    ).toBe("⚠ 2 uncommitted files, branch not merged — delete h? (y/n)");
  });
});
