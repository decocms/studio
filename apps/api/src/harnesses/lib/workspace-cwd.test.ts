import { describe, expect, it } from "bun:test";
import { effectiveCwd } from "./workspace-cwd";

describe("workspace cwd contract", () => {
  it("treats null cwd as no SDK cwd override", () => {
    expect(effectiveCwd(null)).toBeUndefined();
  });

  it("passes /repo through as the symbolic repo cwd", () => {
    expect(effectiveCwd("/repo")).toBe("/repo");
  });
});
