import { describe, expect, it } from "bun:test";

import { prRefsFromGithubEvent, verifyGithubSignature } from "./github-webhook";

const SECRET = "s3cret";
const BODY = JSON.stringify({ ref: "refs/heads/main" });
const VALID = `sha256=${new Bun.CryptoHasher("sha256", SECRET).update(BODY).digest("hex")}`;

describe("verifyGithubSignature", () => {
  it("accepts a signature over the exact bytes", () => {
    expect(verifyGithubSignature(BODY, VALID, SECRET)).toBe(true);
  });

  it("rejects a body that changed by one byte", () => {
    expect(verifyGithubSignature(`${BODY} `, VALID, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyGithubSignature(BODY, VALID, "other")).toBe(false);
  });

  it("rejects a missing, unprefixed, or short header", () => {
    expect(verifyGithubSignature(BODY, undefined, SECRET)).toBe(false);
    expect(
      verifyGithubSignature(BODY, VALID.slice("sha256=".length), SECRET),
    ).toBe(false);
    expect(verifyGithubSignature(BODY, "sha256=abc", SECRET)).toBe(false);
  });
});

describe("prRefsFromGithubEvent", () => {
  const repository = { name: "storefront", owner: { login: "deco-cx" } };

  it("reads every PR a check suite belongs to, deduped", () => {
    expect(
      prRefsFromGithubEvent("check_suite", {
        repository,
        check_suite: { pull_requests: [{ number: 7 }, { number: 7 }] },
      }),
    ).toEqual([{ repoOwner: "deco-cx", repoName: "storefront", number: 7 }]);
  });

  it("reads a PR comment but not an issue comment", () => {
    const issue = { number: 12, pull_request: { url: "https://api/pulls/12" } };
    expect(
      prRefsFromGithubEvent("issue_comment", { repository, issue }),
    ).toEqual([{ repoOwner: "deco-cx", repoName: "storefront", number: 12 }]);
    // No `pull_request` key — a comment on a plain issue names no PR.
    expect(
      prRefsFromGithubEvent("issue_comment", {
        repository,
        issue: { number: 12 },
      }),
    ).toEqual([]);
  });

  it("returns nothing for a push-to-no-PR suite, a wrong shape or another event", () => {
    expect(
      prRefsFromGithubEvent("check_suite", {
        repository,
        check_suite: { pull_requests: [] },
      }),
    ).toEqual([]);
    expect(prRefsFromGithubEvent("check_suite", { check_suite: {} })).toEqual(
      [],
    );
    expect(prRefsFromGithubEvent("push", { repository })).toEqual([]);
  });
});
