import { describe, expect, it } from "bun:test";
import {
  coAuthorFromSessionUser,
  coAuthorFromStudioContext,
} from "./co-author-identity";

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

describe("coAuthorFromStudioContext", () => {
  it("returns null when auth user has no display name", () => {
    expect(
      coAuthorFromStudioContext({
        auth: { user: { id: "u1", email: "jane@example.com" } },
      } as never),
    ).toBeNull();
  });
});
