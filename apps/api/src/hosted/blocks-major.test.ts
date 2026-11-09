import { describe, expect, it } from "bun:test";
import { projectPackagePath } from "./blocks-major";

describe("projectPackagePath", () => {
  it("trims slashes and treats empty as the repo root", () => {
    expect(projectPackagePath({ runtime: { path: "/a/b/" } })).toBe("a/b");
    expect(projectPackagePath({ runtime: { path: "/" } })).toBeNull();
    expect(projectPackagePath(null)).toBeNull();
  });
});
