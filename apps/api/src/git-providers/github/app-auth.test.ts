import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  GITHUB_SCOPED_PERMISSIONS,
  OPTIONAL_MINT_PERMISSIONS,
} from "@decocms/shared/github-repo-scope";
import {
  buildAppJwt,
  installationCacheKey,
  type InstallationToken,
  invalidTokenScope,
  mapInstallation,
  MAX_TOKEN_REPOSITORIES,
  nextPermissionSet,
  pruneExpiredTokens,
  usableAppKey,
} from "./app-auth";

/** A throwaway RSA pair. Real crypto, generated per run — nothing is mocked. */
function throwawayKeyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("buildAppJwt", () => {
  const { privateKey, publicKey } = throwawayKeyPair();
  const now = 1_700_000_000;

  test("emits an RS256 JWT with GitHub's claims", () => {
    const pkcs1 = privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const jwt = buildAppJwt({
      appId: "12345",
      privateKeyPem: pkcs1,
      nowSeconds: now,
    });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [header, payload, signature] = parts as [string, string, string];

    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(payload)).toEqual({
      iat: now - 60,
      exp: now + 540,
      iss: "12345",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  test("accepts PKCS#8 as well as GitHub's PKCS#1 PEM", () => {
    const pkcs8 = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const jwt = buildAppJwt({
      appId: "1",
      privateKeyPem: pkcs8,
      nowSeconds: now,
    });
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  test("a different key does not verify", () => {
    const other = throwawayKeyPair();
    const jwt = buildAppJwt({
      appId: "1",
      privateKeyPem: other.privateKey
        .export({ type: "pkcs1", format: "pem" })
        .toString(),
      nowSeconds: now,
    });
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
  });

  test("stays under GitHub's 10-minute cap", () => {
    const jwt = buildAppJwt({
      appId: "1",
      privateKeyPem: privateKey
        .export({ type: "pkcs1", format: "pem" })
        .toString(),
      nowSeconds: now,
    });
    const payload = decodeSegment(jwt.split(".")[1]!) as {
      iat: number;
      exp: number;
    };
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.iat).toBeLessThan(now);
    expect(payload.exp).toBeGreaterThan(now);
  });
});

describe("nextPermissionSet", () => {
  test("walks the ladder in OPTIONAL_MINT_PERMISSIONS order, then stops", () => {
    const rungs: Record<string, string>[] = [];
    let current: Record<string, string> | null = {
      ...GITHUB_SCOPED_PERMISSIONS,
    };
    while (current) {
      rungs.push(current);
      current = nextPermissionSet(current);
    }
    // Full set, then one rung per optional permission.
    expect(rungs).toHaveLength(OPTIONAL_MINT_PERMISSIONS.length + 1);
    expect(rungs[0]).toEqual(GITHUB_SCOPED_PERMISSIONS);
    for (let i = 0; i < OPTIONAL_MINT_PERMISSIONS.length; i++) {
      const dropped = OPTIONAL_MINT_PERMISSIONS.slice(0, i + 1);
      const rung = rungs[i + 1]!;
      for (const p of dropped) expect(p in rung).toBe(false);
      for (const p of OPTIONAL_MINT_PERMISSIONS.slice(i + 1)) {
        expect(rung[p]).toBe("read");
      }
    }
    const last = rungs[rungs.length - 1]!;
    expect(last).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
    });
  });

  test("never drops a required permission", () => {
    expect(
      nextPermissionSet({ contents: "write", metadata: "read" }),
    ).toBeNull();
    expect(nextPermissionSet({})).toBeNull();
  });

  test("skips optionals that were not requested", () => {
    // `deployments` absent: the first rung drops `checks` directly.
    expect(nextPermissionSet({ contents: "write", checks: "read" })).toEqual({
      contents: "write",
    });
  });

  test("does not mutate its input", () => {
    const input = { contents: "write", deployments: "read" };
    nextPermissionSet(input);
    expect(input).toEqual({ contents: "write", deployments: "read" });
  });
});

describe("installationCacheKey", () => {
  test("is insensitive to repository/permission order and repo casing", () => {
    const a = installationCacheKey(42, {
      repositories: ["Beta", "alpha"],
      permissions: { contents: "write", metadata: "read" },
    });
    const b = installationCacheKey(42, {
      repositories: ["alpha", "beta"],
      permissions: { metadata: "read", contents: "write" },
    });
    expect(a).toBe(b);
  });

  test("distinguishes installation, repositories and permission levels", () => {
    const base = installationCacheKey(1, {
      repositories: ["a"],
      permissions: { contents: "read" },
    });
    expect(
      installationCacheKey(2, {
        repositories: ["a"],
        permissions: { contents: "read" },
      }),
    ).not.toBe(base);
    expect(
      installationCacheKey(1, {
        repositories: ["b"],
        permissions: { contents: "read" },
      }),
    ).not.toBe(base);
    expect(
      installationCacheKey(1, {
        repositories: ["a"],
        permissions: { contents: "write" },
      }),
    ).not.toBe(base);
    expect(installationCacheKey(1, {})).not.toBe(base);
  });

  test("separates a scope by id from the same numbers spelled as names", () => {
    const byId = installationCacheKey(1, { repositoryIds: [7] });
    expect(byId).not.toBe(installationCacheKey(1, { repositories: ["7"] }));
    expect(byId).not.toBe(installationCacheKey(1, {}));
    expect(installationCacheKey(1, { repositoryIds: [9, 7] })).toBe(
      installationCacheKey(1, { repositoryIds: [7, 9] }),
    );
    expect(installationCacheKey(1, { repositoryIds: [7, 9] })).not.toBe(byId);
  });
});

describe("invalidTokenScope", () => {
  test("accepts an unrestricted scope and either restricted spelling", () => {
    expect(invalidTokenScope({})).toBeNull();
    expect(invalidTokenScope({ repositories: ["alpha"] })).toBeNull();
    expect(invalidTokenScope({ repositoryIds: [1] })).toBeNull();
  });

  test("rejects an empty scope, which GitHub would read as every repo", () => {
    expect(invalidTokenScope({ repositories: [] })).toContain("1 to");
    expect(invalidTokenScope({ repositoryIds: [] })).toContain("1 to");
  });

  test("rejects more repositories than GitHub mints for", () => {
    const ids = Array.from(
      { length: MAX_TOKEN_REPOSITORIES + 1 },
      (_, i) => i + 1,
    );
    expect(invalidTokenScope({ repositoryIds: ids })).toContain("1 to");
    expect(invalidTokenScope({ repositoryIds: ids.slice(1) })).toBeNull();
  });

  test("rejects the two spellings together and non-identifier ids", () => {
    expect(
      invalidTokenScope({ repositories: ["alpha"], repositoryIds: [1] }),
    ).toContain("never both");
    expect(invalidTokenScope({ repositoryIds: [0] })).toContain(
      "positive integer",
    );
    expect(invalidTokenScope({ repositoryIds: [1, 1.5] })).toContain(
      "positive integer",
    );
    expect(invalidTokenScope({ repositoryIds: [Number.MAX_VALUE] })).toContain(
      "positive integer",
    );
  });
});

describe("pruneExpiredTokens", () => {
  function tokenExpiringAt(ms: number): InstallationToken {
    return { token: "t", expiresAt: new Date(ms), permissions: {} };
  }

  test("removes only entries whose expiry is at or before now", () => {
    const cache = new Map<string, InstallationToken>([
      ["expired", tokenExpiringAt(1_000)],
      ["boundary", tokenExpiringAt(2_000)],
      ["live", tokenExpiringAt(3_000)],
    ]);

    pruneExpiredTokens(cache, 2_000);

    expect([...cache.keys()]).toEqual(["live"]);
  });

  test("leaves the cache untouched when nothing has expired", () => {
    const cache = new Map<string, InstallationToken>([
      ["a", tokenExpiringAt(5_000)],
      ["b", tokenExpiringAt(6_000)],
    ]);

    pruneExpiredTokens(cache, 1_000);

    expect(cache.size).toBe(2);
  });
});

describe("mapInstallation", () => {
  test("maps a user or organization installation", () => {
    expect(
      mapInstallation({
        id: 77,
        account: {
          id: 9001,
          login: "org_example",
          avatar_url: "https://avatars.example/9001",
          type: "Organization",
        },
      }),
    ).toEqual({
      installationId: 77,
      externalAccountId: "9001",
      login: "org_example",
      avatarUrl: "https://avatars.example/9001",
      accountType: "Organization",
    });
  });

  test("tolerates a missing avatar and type", () => {
    expect(
      mapInstallation({ id: 1, account: { id: 2, login: "someone" } }),
    ).toEqual({
      installationId: 1,
      externalAccountId: "2",
      login: "someone",
      avatarUrl: null,
      accountType: "User",
    });
  });

  test("returns null without a usable account", () => {
    expect(mapInstallation({ id: 1, account: null })).toBeNull();
    expect(mapInstallation({ id: 1 })).toBeNull();
    expect(mapInstallation({ id: 1, account: { login: "x" } })).toBeNull();
    expect(mapInstallation({ account: { id: 2, login: "x" } })).toBeNull();
  });
});

describe("usableAppKey", () => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const config = (privateKeyPem: string) => ({
    appId: "1",
    privateKeyPem,
    clientId: "c",
    clientSecret: "s",
    slug: "studio",
  });

  test("accepts a key that can actually sign", () => {
    expect(usableAppKey(config(key))).toBe(true);
  });

  /**
   * Every one of these is a non-empty string, so the env reader is happy with
   * it. Without this gate they would make the App look configured, take every
   * repository off its legacy connection, and then fail at the first mint.
   */
  test("rejects the ways a PEM arrives mangled from a secret store", () => {
    expect(usableAppKey(config(key.replace(/\n/g, " ")))).toBe(false);
    expect(usableAppKey(config(key.slice(0, 120)))).toBe(false);
    expect(usableAppKey(config("not a key"))).toBe(false);
  });
});
