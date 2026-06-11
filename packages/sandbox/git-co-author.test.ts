import { describe, expect, it } from "bun:test";
import { appendCoAuthorTrailer } from "./git-co-author";

describe("appendCoAuthorTrailer", () => {
  it("appends co-author with display name and email", () => {
    expect(
      appendCoAuthorTrailer("feat: update hero", {
        userName: "Jane Doe",
        userEmail: "jane@example.com",
      }),
    ).toBe("feat: update hero\n\nCo-authored-by: Jane Doe <jane@example.com>");
  });

  it("uses display name only when email is absent", () => {
    expect(appendCoAuthorTrailer("fix: typo", { userName: "Jane Doe" })).toBe(
      "fix: typo\n\nCo-authored-by: Jane Doe",
    );
  });

  it("is idempotent when the trailer is already present", () => {
    const message =
      "feat: update hero\n\nCo-authored-by: Jane Doe <jane@example.com>";
    expect(
      appendCoAuthorTrailer(message, {
        userName: "Jane Doe",
        userEmail: "jane@example.com",
      }),
    ).toBe(message);
  });

  it("returns the original message when operator is missing", () => {
    expect(appendCoAuthorTrailer("feat: noop", null)).toBe("feat: noop");
  });
});
