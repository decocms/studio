import { describe, expect, it } from "bun:test";
import {
  effectiveCwd,
  WORKSPACE_CWD_DEFAULT,
  WORKSPACE_CWD_REPO,
} from "./workspace-cwd";

describe("workspace cwd contract", () => {
  it("treats the 'default' sentinel as no SDK cwd override", () => {
    expect(effectiveCwd(WORKSPACE_CWD_DEFAULT)).toBeUndefined();
  });

  it("passes symbolic non-default paths through unchanged", () => {
    expect(effectiveCwd(WORKSPACE_CWD_REPO)).toBe("/repo");
    expect(effectiveCwd("/data/sandboxes/h1/repo")).toBe(
      "/data/sandboxes/h1/repo",
    );
  });
});
