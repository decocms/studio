import { describe, expect, test } from "bun:test";
import { bitbucketAuthorizeUrl, bitbucketTokenEndpoint } from "./oauth";

describe("bitbucketAuthorizeUrl", () => {
  const base = {
    clientId: "consumer-key",
    redirectUri: "https://studio.example.com/api/_git/bitbucket/callback",
    state: "opaque-state",
  };

  test("targets bitbucket.org's authorize page with the code flow params", () => {
    const url = new URL(bitbucketAuthorizeUrl(base));
    expect(url.origin).toBe("https://bitbucket.org");
    expect(url.pathname).toBe("/site/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("consumer-key");
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("opaque-state");
  });

  test("carries no scope — scopes live on the consumer", () => {
    const url = new URL(bitbucketAuthorizeUrl(base));
    expect(url.searchParams.has("scope")).toBe(false);
  });

  test("encodes the redirect URI so its own query string survives", () => {
    const redirectUri = "https://studio.example.com/cb?next=/repos&x=1";
    const url = new URL(bitbucketAuthorizeUrl({ ...base, redirectUri }));
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
  });
});

describe("bitbucketTokenEndpoint", () => {
  test("is the site's access_token endpoint", () => {
    expect(bitbucketTokenEndpoint()).toBe(
      "https://bitbucket.org/site/oauth2/access_token",
    );
  });
});
