import { describe, expect, test } from "bun:test";
import {
  claudeSubscriptionAuthorizeUrl,
  splitPastedCode,
} from "./claude-subscription-oauth";

describe("splitPastedCode", () => {
  test("splits the `code#state` string Anthropic displays", () => {
    expect(splitPastedCode("  abc#st-1 ")).toEqual({
      code: "abc",
      state: "st-1",
    });
  });

  test("a bare code carries no state to verify", () => {
    expect(splitPastedCode("abc")).toEqual({ code: "abc" });
  });
});

describe("claudeSubscriptionAuthorizeUrl", () => {
  test("carries the PKCE challenge and state", () => {
    const url = new URL(
      claudeSubscriptionAuthorizeUrl({ codeChallenge: "ch", state: "st" }),
    );
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")).toContain("user:inference");
  });
});
