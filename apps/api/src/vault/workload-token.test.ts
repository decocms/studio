import { describe, expect, test } from "bun:test";
import {
  generateWorkloadToken,
  hashWorkloadToken,
  parseWorkloadTokenPrefix,
  verifyWorkloadToken,
} from "./workload-token";

describe("workload token helpers", () => {
  test("generates stv-prefixed opaque tokens with a loggable prefix", () => {
    const token = generateWorkloadToken();
    expect(token.plaintext.startsWith("stv_")).toBe(true);
    expect(token.prefix.length).toBe(12);
    expect(token.plaintext.includes(token.prefix)).toBe(true);
    expect(parseWorkloadTokenPrefix(token.plaintext)).toBe(token.prefix);
  });

  test("hashes and verifies tokens without storing plaintext", () => {
    const token = generateWorkloadToken();
    const hash = hashWorkloadToken(token.plaintext);
    expect(hash).not.toContain(token.plaintext);
    expect(verifyWorkloadToken(token.plaintext, hash)).toBe(true);
    expect(verifyWorkloadToken(`${token.plaintext}x`, hash)).toBe(false);
  });

  test("rejects malformed prefixes", () => {
    expect(parseWorkloadTokenPrefix("not-a-token")).toBe(null);
    expect(parseWorkloadTokenPrefix("stv_short")).toBe(null);
    expect(parseWorkloadTokenPrefix("stv_!!!!!!!!!!!!_x")).toBe(null);
    expect(parseWorkloadTokenPrefix("stv_abcdefghijkl_!")).toBe(null);
  });
});
