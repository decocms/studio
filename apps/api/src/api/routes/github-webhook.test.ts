import { describe, expect, it } from "bun:test";

import { verifyGithubSignature } from "./github-webhook";

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
