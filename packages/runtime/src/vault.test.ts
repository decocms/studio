import { describe, expect, it } from "bun:test";
import { createStudioVaultClient } from "./vault.ts";

describe("createStudioVaultClient", () => {
  it("requests and returns an OAuth access token for a connection binding", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetch = Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init: Parameters<typeof globalThis.fetch>[1],
      ) => {
        requestUrl = input;
        requestInit = init;

        return Response.json({
          type: "oauth_access_token",
          tokenType: "Bearer",
          accessToken: "gho_token",
          expiresAt: "2026-06-30T12:00:00.000Z",
          scope: "repo",
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) satisfies typeof globalThis.fetch;

    const client = createStudioVaultClient({
      baseUrl: "https://studio.test",
      org: "acme",
      token: "stv_prefix_secret",
      fetch,
    });

    const accessToken = await client.getAccessToken({
      __type: "@deco/github",
      value: "conn_github",
    });

    expect(requestUrl).toBe(
      "https://studio.test/api/acme/vault/connections/conn_github/access-token",
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual({
      Authorization: "Bearer stv_prefix_secret",
      "Content-Type": "application/json",
    });
    expect(requestInit?.body).toBe("{}");
    expect(accessToken.accessToken).toBe("gho_token");
  });

  it("accepts a raw connection id and avoids double slashes", async () => {
    let requestUrl: string | URL | Request | undefined;
    const fetch = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        requestUrl = input;

        return Response.json({
          type: "oauth_access_token",
          tokenType: "Bearer",
          accessToken: "github-token",
          expiresAt: null,
          scope: null,
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ) satisfies typeof globalThis.fetch;

    const client = createStudioVaultClient({
      baseUrl: "https://studio.test/",
      org: "acme",
      token: "stv_prefix_secret",
      fetch,
    });

    await client.getAccessToken("conn_github");

    expect(requestUrl).toBe(
      "https://studio.test/api/acme/vault/connections/conn_github/access-token",
    );
  });

  it("throws when Studio rejects the token request", async () => {
    const fetch = Object.assign(
      async () => new Response(null, { status: 403 }),
      { preconnect: globalThis.fetch.preconnect },
    ) satisfies typeof globalThis.fetch;

    const client = createStudioVaultClient({
      baseUrl: "https://studio.test",
      org: "acme",
      token: "stv_prefix_secret",
      fetch,
    });

    expect(client.getAccessToken("conn_github")).rejects.toThrow(
      "Studio vault token request failed: 403",
    );
  });
});
