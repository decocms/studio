import { describe, expect, test } from "bun:test";
import { repoTargetOf } from "./repo-target";

describe("repoTargetOf", () => {
  test("throws on an unparseable repoUrl instead of silently dropping it", () => {
    expect(() => repoTargetOf({ repoUrl: "not a url" })).toThrow(
      "Could not recognise the repository URL: not a url",
    );
  });

  test("resolves a valid repoUrl to a ref", () => {
    const target = repoTargetOf({
      repoUrl: "https://github.com/decocms/studio",
    });
    expect(target.ref?.host).toBe("github.com");
    expect(target.ref?.path).toBe("decocms/studio");
  });

  test("passes through repositoryId and connectionId with no repoUrl", () => {
    const target = repoTargetOf({
      repositoryId: "repo_1",
      connectionId: "conn_1",
    });
    expect(target).toEqual({
      repositoryId: "repo_1",
      ref: null,
      connectionId: "conn_1",
    });
  });
});
