import { describe, expect, test } from "bun:test";
import { getDevAssetsSigningSecret } from "./dev-assets-secret";

describe("getDevAssetsSigningSecret", () => {
  test("never falls back to the old hardcoded literal", () => {
    expect(getDevAssetsSigningSecret()).not.toBe("dev-secret");
  });

  test("is memoized across calls (sign and verify must agree)", () => {
    expect(getDevAssetsSigningSecret()).toBe(getDevAssetsSigningSecret());
  });
});
