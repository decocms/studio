import { describe, expect, test } from "bun:test";
import { gitlabAuthorizeUrl, gitlabTokenEndpoint } from "./oauth";

describe("gitlabAuthorizeUrl", () => {
  const base = {
    host: "gitlab.com",
    clientId: "client-123",
    redirectUri: "https://studio.example.com/api/git/gitlab/callback",
    state: "opaque-state",
  };

  test("targets /oauth/authorize on the given host with the code flow params", () => {
    const url = new URL(gitlabAuthorizeUrl(base));
    expect(url.origin).toBe("https://gitlab.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("opaque-state");
  });

  test("defaults to the api and read_user scopes, space-joined", () => {
    const url = new URL(gitlabAuthorizeUrl(base));
    expect(url.searchParams.get("scope")).toBe("api read_user");
  });

  test("honours custom scopes", () => {
    const url = new URL(
      gitlabAuthorizeUrl({ ...base, scopes: ["read_api", "read_repository"] }),
    );
    expect(url.searchParams.get("scope")).toBe("read_api read_repository");
  });

  test("supports self-managed hosts", () => {
    const url = new URL(gitlabAuthorizeUrl({ ...base, host: "git.corp.io" }));
    expect(url.origin).toBe("https://git.corp.io");
  });

  test("encodes the redirect URI so its own query string survives", () => {
    const redirectUri = "https://studio.example.com/cb?next=/repos&x=1";
    const url = new URL(gitlabAuthorizeUrl({ ...base, redirectUri }));
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
  });
});

describe("gitlabTokenEndpoint", () => {
  test("is /oauth/token on the host", () => {
    expect(gitlabTokenEndpoint("gitlab.com")).toBe(
      "https://gitlab.com/oauth/token",
    );
    expect(gitlabTokenEndpoint("git.corp.io")).toBe(
      "https://git.corp.io/oauth/token",
    );
  });
});
