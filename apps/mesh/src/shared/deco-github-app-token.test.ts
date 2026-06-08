import { describe, expect, it } from "bun:test";
import {
  createInstallationRepoToken,
  fetchRepoInstallationId,
  mintFromOctokitToken,
  normalizeGithubAppPrivateKey,
} from "./deco-github-app-token";

describe("normalizeGithubAppPrivateKey", () => {
  it("replaces escaped newlines", () => {
    expect(normalizeGithubAppPrivateKey("line1\\nline2")).toBe("line1\nline2");
  });
});

describe("mintFromOctokitToken", () => {
  it("returns a non-expiring token", () => {
    expect(mintFromOctokitToken("ghp_test")).toEqual({
      accessToken: "ghp_test",
      expiresAt: null,
      installationId: null,
    });
  });
});

describe("fetchRepoInstallationId", () => {
  it("returns installation id from GitHub API", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ id: 42 }), { status: 200 });
    const id = await fetchRepoInstallationId(
      "jwt",
      "deco-sites",
      "mysite",
      fetchFn,
    );
    expect(id).toBe(42);
  });

  it("throws on non-OK response", async () => {
    const fetchFn = async () => new Response("", { status: 404 });
    await expect(
      fetchRepoInstallationId("jwt", "deco-sites", "mysite", fetchFn),
    ).rejects.toThrow("installation lookup failed");
  });
});

describe("createInstallationRepoToken", () => {
  it("parses token and expiry from GitHub API", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          token: "ghs_scoped",
          expires_at: "2026-06-05T12:00:00Z",
        }),
        { status: 201 },
      );
    const minted = await createInstallationRepoToken(
      "jwt",
      7,
      "mysite",
      { contents: "write" },
      fetchFn,
    );
    expect(minted.accessToken).toBe("ghs_scoped");
    expect(minted.installationId).toBe(7);
    expect(minted.expiresAt?.toISOString()).toBe("2026-06-05T12:00:00.000Z");
  });
});
