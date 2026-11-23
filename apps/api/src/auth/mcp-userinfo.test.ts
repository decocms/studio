import { describe, expect, it } from "bun:test";
import {
  bearerToken,
  grantedScopes,
  isTokenUsable,
  userinfoClaims,
  type UserinfoUser,
} from "./mcp-userinfo";

const user: UserinfoUser = {
  id: "user-1",
  email: "person@example.test",
  emailVerified: true,
  name: "Ada Maria Lovelace",
  image: "https://cdn.example.test/a.png",
};

describe("bearerToken", () => {
  it("reads a Bearer token, case-insensitively", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc ")).toBe("abc");
  });

  it("rejects missing, empty and other schemes", () => {
    for (const header of [
      null,
      undefined,
      "",
      "Bearer",
      "Bearer  ",
      "Basic abc",
      "Bearer a b",
    ])
      expect(bearerToken(header)).toBeNull();
  });
});

describe("isTokenUsable", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("accepts a token that expires later, as a Date or a string", () => {
    expect(
      isTokenUsable(
        {
          accessTokenExpiresAt: new Date("2026-01-01T00:00:01Z"),
          scopes: null,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isTokenUsable(
        { accessTokenExpiresAt: "2026-01-02T00:00:00Z", scopes: null },
        now,
      ),
    ).toBe(true);
  });

  it("rejects expired, exactly-now, missing and unparseable expiries", () => {
    for (const accessTokenExpiresAt of [
      new Date("2025-12-31T23:59:59Z"),
      now,
      null,
      "not a date",
    ])
      expect(isTokenUsable({ accessTokenExpiresAt, scopes: null }, now)).toBe(
        false,
      );
  });
});

describe("userinfoClaims", () => {
  it("returns only sub without email or profile scope", () => {
    expect(userinfoClaims(user, grantedScopes("openid"))).toEqual({
      sub: "user-1",
    });
    expect(userinfoClaims(user, grantedScopes(null))).toEqual({
      sub: "user-1",
    });
  });

  it("adds email claims only with the email scope", () => {
    expect(userinfoClaims(user, grantedScopes("openid email"))).toEqual({
      sub: "user-1",
      email: "person@example.test",
      email_verified: true,
    });
    expect(
      userinfoClaims({ ...user, emailVerified: false }, grantedScopes("email"))
        .email_verified,
    ).toBe(false);
  });

  it("adds profile claims only with the profile scope", () => {
    expect(userinfoClaims(user, grantedScopes("openid  profile"))).toEqual({
      sub: "user-1",
      name: "Ada Maria Lovelace",
      given_name: "Ada",
      family_name: "Maria Lovelace",
      picture: "https://cdn.example.test/a.png",
    });
  });

  it("leaves out empty names and unsafe or oversized pictures", () => {
    const scopes = grantedScopes("profile");
    expect(
      userinfoClaims({ ...user, name: "  ", image: null }, scopes),
    ).toEqual({ sub: "user-1" });
    expect(userinfoClaims({ ...user, name: "Ada" }, scopes)).toMatchObject({
      name: "Ada",
      given_name: "Ada",
    });
    expect(userinfoClaims({ ...user, name: "Ada" }, scopes)).not.toHaveProperty(
      "family_name",
    );
    for (const image of [
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "not a url",
      `https://cdn.example.test/${"a".repeat(2100)}`,
    ])
      expect(userinfoClaims({ ...user, image }, scopes)).not.toHaveProperty(
        "picture",
      );
  });
});
