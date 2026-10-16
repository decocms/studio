import { describe, expect, test } from "bun:test";
import { tokenInfoFromGrant } from "./sandbox-sign-in";

describe("tokenInfoFromGrant", () => {
  test("turns Claude Code's grant into the oauth-token body", () => {
    expect(
      tokenInfoFromGrant(
        {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: 10_500,
          clientId: "cid",
        },
        "https://auth.example/token",
        1_000,
      ),
    ).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 9,
      scope: null,
      clientId: "cid",
      clientSecret: null,
      tokenEndpoint: "https://auth.example/token",
    });
  });

  test("keeps a missing expiry unknown and a past one at zero", () => {
    expect(
      tokenInfoFromGrant({ accessToken: "at" }, null).expiresIn,
    ).toBeNull();
    expect(
      tokenInfoFromGrant({ accessToken: "at", expiresAt: 1 }, null, 5_000)
        .expiresIn,
    ).toBe(0);
  });
});
