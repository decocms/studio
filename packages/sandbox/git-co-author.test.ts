import { describe, expect, it } from "bun:test";
import {
  appendCoAuthorTrailer,
  normalizeCoAuthorIdentity,
  stripCoAuthorTrailers,
} from "./git-co-author";

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

  it("replaces client-supplied co-author trailers with the trusted one", () => {
    expect(
      appendCoAuthorTrailer(
        "feat: update\n\nCo-authored-by: Attacker <evil@example.com>",
        { userName: "Jane Doe", userEmail: "jane@example.com" },
      ),
    ).toBe("feat: update\n\nCo-authored-by: Jane Doe <jane@example.com>");
  });

  it("stays idempotent across proxy and daemon append passes", () => {
    const operator = {
      userName: "Jane Doe",
      userEmail: "jane@example.com",
    };
    const afterProxy = appendCoAuthorTrailer("feat: update hero", operator);
    const afterDaemon = appendCoAuthorTrailer(afterProxy, operator);
    expect(afterDaemon).toBe(
      "feat: update hero\n\nCo-authored-by: Jane Doe <jane@example.com>",
    );
  });

  it("rejects unsafe display names", () => {
    expect(
      appendCoAuthorTrailer("feat: update", {
        userName: "Jane\nCo-authored-by: Evil <evil@example.com>",
        userEmail: "jane@example.com",
      }),
    ).toBe("feat: update");
  });
});

describe("normalizeCoAuthorIdentity", () => {
  it("trims and drops invalid emails", () => {
    expect(
      normalizeCoAuthorIdentity({
        userName: " Jane ",
        userEmail: "not-an-email",
      }),
    ).toEqual({ userName: "Jane" });
  });
});

describe("stripCoAuthorTrailers", () => {
  it("removes co-author lines only", () => {
    expect(
      stripCoAuthorTrailers(
        "feat: x\n\nCo-authored-by: A <a@example.com>\nCo-authored-by: B",
      ),
    ).toBe("feat: x");
  });
});
