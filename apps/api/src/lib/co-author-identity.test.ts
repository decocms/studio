import { describe, expect, it } from "bun:test";
import { coAuthorFromStudioContext } from "./co-author-identity";

describe("coAuthorFromStudioContext", () => {
  it("returns undefined when auth user has no display name", () => {
    expect(
      coAuthorFromStudioContext({
        auth: { user: { id: "u1", email: "jane@example.com" } },
      } as never),
    ).toBeUndefined();
  });
});
