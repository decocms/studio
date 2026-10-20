import { describe, expect, it } from "bun:test";
import {
  appendCoAuthorTrailer,
  commitAttribution,
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

  it("keeps real addresses and rejects malformed dot runs", () => {
    for (const userEmail of [
      "jane@example.com",
      "jane@mail.example.co.uk",
      "1+jane@users.noreply.github.com",
    ]) {
      expect(
        normalizeCoAuthorIdentity({ userName: "Jane", userEmail }),
      ).toEqual({ userName: "Jane", userEmail });
    }
    for (const userEmail of ["jane@example..com", "jane@example.com.", "a@b"]) {
      expect(
        normalizeCoAuthorIdentity({ userName: "Jane", userEmail }),
      ).toEqual({ userName: "Jane" });
    }
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

describe("commitAttribution", () => {
  it("makes a complete operator the author and drops the trailer", () => {
    expect(
      commitAttribution("feat: update hero", {
        userName: "Jane Doe",
        userEmail: "jane@example.com",
      }),
    ).toEqual({
      message: "feat: update hero",
      author: { name: "Jane Doe", email: "jane@example.com" },
    });
  });

  it("strips a trailer the message already carried for that operator", () => {
    expect(
      commitAttribution(
        "feat: x\n\nCo-authored-by: Jane Doe <jane@example.com>",
        { userName: "Jane Doe", userEmail: "jane@example.com" },
      ),
    ).toEqual({
      message: "feat: x",
      author: { name: "Jane Doe", email: "jane@example.com" },
    });
  });

  it("falls back to the trailer without a usable email", () => {
    expect(commitAttribution("fix: typo", { userName: "Jane Doe" })).toEqual({
      message: "fix: typo\n\nCo-authored-by: Jane Doe",
      author: null,
    });
    expect(
      commitAttribution("fix: typo", {
        userName: "Jane Doe",
        userEmail: "not-an-email",
      }),
    ).toEqual({
      message: "fix: typo\n\nCo-authored-by: Jane Doe",
      author: null,
    });
  });

  it("keeps them a co-author when the flag says they may not author", () => {
    expect(
      commitAttribution("feat: update hero", {
        userName: "Jane Doe",
        userEmail: "jane@example.com",
        authorsCommit: false,
      }),
    ).toEqual({
      message:
        "feat: update hero\n\nCo-authored-by: Jane Doe <jane@example.com>",
      author: null,
    });
  });

  it("leaves the message alone and authors nothing without an operator", () => {
    expect(commitAttribution("chore: x", null)).toEqual({
      message: "chore: x",
      author: null,
    });
  });

  it("drops a client-supplied trailer the operator did not write", () => {
    expect(
      commitAttribution(
        "feat: x\n\nCo-authored-by: Attacker <evil@example.com>",
        { userName: "Jane Doe", userEmail: "jane@example.com" },
      ),
    ).toEqual({
      message: "feat: x",
      author: { name: "Jane Doe", email: "jane@example.com" },
    });
  });
});
