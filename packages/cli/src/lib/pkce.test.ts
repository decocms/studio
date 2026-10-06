import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { generatePkcePair } from "./pkce";

describe("generatePkcePair", () => {
  it("returns a verifier between 43 and 128 base64url chars (RFC 7636)", () => {
    const { verifier } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkcePair();
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("produces different pairs on each call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
