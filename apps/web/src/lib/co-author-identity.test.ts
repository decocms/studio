import { describe, expect, it } from "bun:test";
import { coAuthorFromSessionUser } from "./co-author-identity";

describe("coAuthorFromSessionUser", () => {
  it("normalizes display name and email", () => {
    expect(
      coAuthorFromSessionUser({
        name: " Jane ",
        email: " jane@example.com ",
      }),
    ).toEqual({
      userName: "Jane",
      userEmail: "jane@example.com",
    });
  });
});
