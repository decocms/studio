import { describe, expect, it } from "bun:test";
import { REPOSITORY_COLLABORATOR_ADD } from "./collaborators";

describe("REPOSITORY_COLLABORATOR_ADD input", () => {
  it("accepts GitHub logins and defaults to write access", () => {
    const parsed = REPOSITORY_COLLABORATOR_ADD.inputSchema.parse({
      repositoryId: "repo-1",
      username: "  octo-cat ",
    });
    expect(parsed).toEqual({
      repositoryId: "repo-1",
      username: "octo-cat",
      permission: "write",
    });
  });

  it("rejects empty, malformed and oversized logins", () => {
    for (const username of [
      "",
      "-octo",
      "octo-",
      "oc--to",
      "octo cat",
      "octo/cat",
      "a".repeat(40),
    ]) {
      expect(
        REPOSITORY_COLLABORATOR_ADD.inputSchema.safeParse({
          repositoryId: "repo-1",
          username,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a permission GitHub does not have", () => {
    expect(
      REPOSITORY_COLLABORATOR_ADD.inputSchema.safeParse({
        repositoryId: "repo-1",
        username: "ana",
        permission: "owner",
      }).success,
    ).toBe(false);
  });
});
