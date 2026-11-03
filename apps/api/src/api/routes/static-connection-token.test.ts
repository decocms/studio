import { describe, expect, test } from "bun:test";
import { presentStaticConnectionToken } from "./static-connection-token";

describe("presentStaticConnectionToken", () => {
  test("keeps a bare secret as a Bearer token", () => {
    expect(presentStaticConnectionToken("static-admin-api-token")).toEqual({
      tokenType: "Bearer",
      accessToken: "static-admin-api-token",
    });
  });

  test("trims a bare secret before labeling it Bearer", () => {
    expect(presentStaticConnectionToken("  abc123  ")).toEqual({
      tokenType: "Bearer",
      accessToken: "abc123",
    });
  });

  test("splits a token that already carries its own scheme", () => {
    expect(presentStaticConnectionToken("Token token=abc123")).toEqual({
      tokenType: "Token",
      accessToken: "token=abc123",
    });
  });

  test("keeps spaces that belong to the token value", () => {
    expect(presentStaticConnectionToken("Token  token=a b")).toEqual({
      tokenType: "Token",
      accessToken: "token=a b",
    });
  });

  test("does not report Bearer twice when the stored value is already Bearer", () => {
    expect(presentStaticConnectionToken("Bearer abc123")).toEqual({
      tokenType: "Bearer",
      accessToken: "abc123",
    });
  });
});
