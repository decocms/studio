import { describe, expect, test } from "bun:test";
import {
  claudeSubscriptionAuthorizeUrl,
  splitPastedCode,
} from "./claude-subscription-oauth";
import { getSettings } from "../settings";

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

  test("never asks for the API-key scope", () => {
    // `org:create_api_key` mints an API key, whose usage bills the org's API
    // credit — the exact outcome linking a subscription exists to avoid.
    const url = new URL(
      claudeSubscriptionAuthorizeUrl({ codeChallenge: "ch", state: "st" }),
    );
    expect(url.searchParams.get("scope")).not.toContain("create_api_key");
  });

  test("the client id comes from settings, so it can be replaced", () => {
    const url = new URL(
      claudeSubscriptionAuthorizeUrl({ codeChallenge: "ch", state: "st" }),
    );
    expect(url.searchParams.get("client_id")).toBe(
      getSettings().claudeSubscriptionClientId,
    );
  });
});
