import { describe, expect, test } from "bun:test";
import { canRefresh } from "@/oauth/token-refresh";
import type { DownstreamToken } from "@/storage/types";

/**
 * `grantTokenSource` forces a refresh only when the stored grant can actually
 * be refreshed. `canRefresh` is that predicate; a long-lived access token
 * fails it, and forcing one down the refresh path yields no token at all —
 * which is how every GitLab token account would have failed to start a
 * sandbox, since SANDBOX_START always asks for a freshly-minted credential.
 */
function grant(overrides: Partial<DownstreamToken>): DownstreamToken {
  return {
    id: "tok",
    connectionId: "acc_1",
    accessToken: "secret",
    refreshToken: null,
    scope: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    clientId: null,
    clientSecret: null,
    tokenEndpoint: null,
    ...overrides,
  };
}

describe("refreshability of a stored git provider grant", () => {
  test("a personal or project access token is not refreshable", () => {
    expect(canRefresh(grant({}))).toBe(false);
  });

  test("an OAuth grant with the full refresh triple is refreshable", () => {
    expect(
      canRefresh(
        grant({
          refreshToken: "r",
          clientId: "c",
          tokenEndpoint: "https://gitlab.com/oauth/token",
        }),
      ),
    ).toBe(true);
  });

  test("a partial grant is not refreshable", () => {
    expect(canRefresh(grant({ refreshToken: "r" }))).toBe(false);
    expect(canRefresh(grant({ refreshToken: "r", clientId: "c" }))).toBe(false);
  });
});
