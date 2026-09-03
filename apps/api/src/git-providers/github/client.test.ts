import { describe, expect, test } from "bun:test";
import {
  type GithubRepoJson,
  mapGithubIdentity,
  mapGithubRepo,
  matchesRepoQuery,
} from "./client";
import { githubErrorMessage } from "./http";

const base: GithubRepoJson = {
  id: 1296269,
  full_name: "octocat/Hello-World",
  private: false,
  visibility: "public",
  default_branch: "master",
  html_url: "https://github.com/octocat/Hello-World",
  description: "This your first repo!",
  pushed_at: "2011-01-26T19:06:43Z",
  updated_at: "2011-01-26T19:14:43Z",
};

describe("mapGithubRepo", () => {
  test("maps a public repository, preferring pushed_at", () => {
    expect(mapGithubRepo(base, "github.com")).toEqual({
      ref: {
        provider: "github",
        host: "github.com",
        path: "octocat/Hello-World",
      },
      externalId: "1296269",
      defaultBranch: "master",
      webUrl: "https://github.com/octocat/Hello-World",
      visibility: "public",
      description: "This your first repo!",
      updatedAt: "2011-01-26T19:06:43Z",
    });
  });

  test("`private: true` wins over any visibility string", () => {
    expect(
      mapGithubRepo(
        { ...base, private: true, visibility: "public" },
        "github.com",
      ).visibility,
    ).toBe("private");
    expect(
      mapGithubRepo({ ...base, private: true, visibility: null }, "github.com")
        .visibility,
    ).toBe("private");
  });

  test("keeps `internal` (GitHub Enterprise) and defaults unknown to public", () => {
    expect(
      mapGithubRepo({ ...base, visibility: "internal" }, "ghe.example.com")
        .visibility,
    ).toBe("internal");
    expect(
      mapGithubRepo({ ...base, visibility: undefined }, "github.com")
        .visibility,
    ).toBe("public");
    expect(
      mapGithubRepo({ ...base, visibility: "weird" }, "github.com").visibility,
    ).toBe("public");
  });

  test("falls back to updated_at, then null, for the activity timestamp", () => {
    expect(
      mapGithubRepo({ ...base, pushed_at: null }, "github.com").updatedAt,
    ).toBe("2011-01-26T19:14:43Z");
    expect(
      mapGithubRepo(
        { ...base, pushed_at: null, updated_at: null },
        "github.com",
      ).updatedAt,
    ).toBeNull();
  });

  test("nulls an absent description and default branch", () => {
    const mapped = mapGithubRepo(
      { ...base, description: null, default_branch: undefined },
      "github.com",
    );
    expect(mapped.description).toBeNull();
    expect(mapped.defaultBranch).toBeNull();
  });

  test("stamps the client's host onto the ref", () => {
    expect(mapGithubRepo(base, "ghe.example.com").ref.host).toBe(
      "ghe.example.com",
    );
  });
});

describe("matchesRepoQuery", () => {
  test("is a case-insensitive substring match over owner/name", () => {
    expect(matchesRepoQuery("octocat/Hello-World", "hello")).toBe(true);
    expect(matchesRepoQuery("octocat/Hello-World", "OCTO")).toBe(true);
    expect(matchesRepoQuery("octocat/Hello-World", "cat/hel")).toBe(true);
    expect(matchesRepoQuery("octocat/Hello-World", "goodbye")).toBe(false);
  });

  test("blank or missing queries match everything", () => {
    expect(matchesRepoQuery("octocat/Hello-World", undefined)).toBe(true);
    expect(matchesRepoQuery("octocat/Hello-World", "")).toBe(true);
    expect(matchesRepoQuery("octocat/Hello-World", "   ")).toBe(true);
  });

  test("trims the query", () => {
    expect(matchesRepoQuery("octocat/Hello-World", "  world ")).toBe(true);
  });
});

describe("mapGithubIdentity", () => {
  test("uses the profile name and public email when present", () => {
    expect(
      mapGithubIdentity({
        login: "octocat",
        name: "The Octocat",
        email: "octocat@example.com",
      }),
    ).toEqual({ name: "The Octocat", email: "octocat@example.com" });
  });

  test("falls back to login and the noreply address", () => {
    expect(
      mapGithubIdentity({ login: "octocat", name: null, email: null }),
    ).toEqual({ name: "octocat", email: "octocat@users.noreply.github.com" });
    expect(
      mapGithubIdentity({ login: "octocat", name: "", email: "" }),
    ).toEqual({ name: "octocat", email: "octocat@users.noreply.github.com" });
    expect(mapGithubIdentity({ login: "octocat" })).toEqual({
      name: "octocat",
      email: "octocat@users.noreply.github.com",
    });
  });
});

describe("githubErrorMessage", () => {
  test("prefers GitHub's JSON `message`", () => {
    expect(
      githubErrorMessage(
        JSON.stringify({
          message: "Resource not accessible by integration",
          documentation_url: "https://docs.github.com/...",
        }),
      ),
    ).toBe("Resource not accessible by integration");
  });

  test("falls back to the truncated raw body for non-JSON or message-less bodies", () => {
    expect(githubErrorMessage("<html>502 Bad Gateway</html>")).toBe(
      "<html>502 Bad Gateway</html>",
    );
    expect(githubErrorMessage(JSON.stringify({ error: "x" }))).toBe(
      '{"error":"x"}',
    );
    expect(githubErrorMessage("")).toBe("");
    expect(githubErrorMessage("a".repeat(500))).toHaveLength(300);
  });
});
