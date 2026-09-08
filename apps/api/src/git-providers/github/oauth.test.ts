import { describe, expect, test } from "bun:test";
import { GitProviderError } from "../types";
import {
  GITHUB_OAUTH_TOKEN_URL,
  githubAuthorizeUrl,
  parseGithubTokenResponse,
} from "./oauth";

describe("githubAuthorizeUrl", () => {
  test("targets github.com's authorize endpoint with the three parameters", () => {
    const url = new URL(
      githubAuthorizeUrl({
        clientId: "Iv1.abc",
        redirectUri: "https://studio.example/api/git-providers/github/callback",
        state: "opaque-state",
      }),
    );
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://studio.example/api/git-providers/github/callback",
    );
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "redirect_uri",
      "state",
    ]);
  });

  test("encodes a redirect URI that carries its own query string", () => {
    const redirectUri = "https://studio.example/cb?org=acme&x=1 2";
    const url = new URL(
      githubAuthorizeUrl({ clientId: "c", redirectUri, state: "s" }),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.search).not.toContain("org=acme");
  });
});

describe("parseGithubTokenResponse", () => {
  test("maps a full expiring-token response", () => {
    expect(
      parseGithubTokenResponse({
        access_token: "ghu_token",
        expires_in: 28800,
        refresh_token: "ghr_refresh",
        refresh_token_expires_in: 15811200,
        scope: "",
        token_type: "bearer",
      }),
    ).toEqual({
      accessToken: "ghu_token",
      refreshToken: "ghr_refresh",
      expiresIn: 28800,
      scope: null,
      tokenEndpoint: GITHUB_OAUTH_TOKEN_URL,
    });
  });

  test("maps a non-expiring token", () => {
    expect(
      parseGithubTokenResponse({
        access_token: "gho_token",
        scope: "repo,read:org",
        token_type: "bearer",
      }),
    ).toEqual({
      accessToken: "gho_token",
      refreshToken: null,
      expiresIn: null,
      scope: "repo,read:org",
      tokenEndpoint: GITHUB_OAUTH_TOKEN_URL,
    });
  });

  test("turns GitHub's 200-with-error body into a GitProviderError", () => {
    let caught: unknown;
    try {
      parseGithubTokenResponse({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
        error_uri: "https://docs.github.com/...",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitProviderError);
    const err = caught as GitProviderError;
    expect(err.provider).toBe("github");
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad_verification_code");
    expect(err.message).toContain("incorrect or expired");
  });

  test("rejects a body with neither token nor error, echoing the HTTP status", () => {
    for (const body of [{}, null, "nope", { access_token: "" }]) {
      let caught: unknown;
      try {
        parseGithubTokenResponse(body, 200);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GitProviderError);
      expect((caught as GitProviderError).status).toBe(200);
    }
  });
});
