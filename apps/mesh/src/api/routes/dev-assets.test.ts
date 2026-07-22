import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getSettings } from "../../settings";
import { verifySignature } from "./dev-assets";

function sign(
  orgId: string,
  key: string,
  expires: number,
  method: "GET" | "PUT",
): string {
  const secret = getSettings().encryptionKey || "dev-secret";
  return createHmac("sha256", secret)
    .update(`${orgId}:${key}:${expires}:${method}`)
    .digest("hex");
}

describe("verifySignature", () => {
  test("accepts a signature matching the expected HMAC", () => {
    const signature = sign("org_1", "logo.png", 9999999999, "GET");
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "GET", signature),
    ).toBe(true);
  });

  test("rejects a same-length signature that doesn't match", () => {
    const signature = sign("org_1", "logo.png", 9999999999, "GET");
    const tampered = `${signature.slice(0, -1)}${signature.at(-1) === "0" ? "1" : "0"}`;
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "GET", tampered),
    ).toBe(false);
  });

  test("rejects a mismatched-length signature without throwing", () => {
    expect(() =>
      verifySignature("org_1", "logo.png", 9999999999, "GET", "short"),
    ).not.toThrow();
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "GET", "short"),
    ).toBe(false);
  });

  test("rejects a signature minted for a different method", () => {
    const signature = sign("org_1", "logo.png", 9999999999, "GET");
    expect(
      verifySignature("org_1", "logo.png", 9999999999, "PUT", signature),
    ).toBe(false);
  });
});
