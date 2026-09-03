import { describe, expect, test } from "bun:test";
import {
  encodeFilePath,
  encodeProjectPath,
  gitlabRetryAfterMs,
  mapGitlabProject,
} from "./client";

describe("encodeProjectPath", () => {
  test("encodes every namespace slash", () => {
    expect(encodeProjectPath("group/sub/project")).toBe(
      "group%2Fsub%2Fproject",
    );
  });

  test("leaves dots and dashes alone (GitLab accepts them literally)", () => {
    expect(encodeProjectPath("my-group/my.project")).toBe(
      "my-group%2Fmy.project",
    );
  });

  test("encodes characters that are not URL-safe", () => {
    expect(encodeProjectPath("group/proj ect")).toBe("group%2Fproj%20ect");
  });
});

describe("encodeFilePath", () => {
  test("encodes directory separators", () => {
    expect(encodeFilePath("src/app.ts")).toBe("src%2Fapp.ts");
    expect(encodeFilePath("a/b/c/d.json")).toBe("a%2Fb%2Fc%2Fd.json");
  });

  test("keeps dotfiles and dots in names", () => {
    expect(encodeFilePath(".gitlab-ci.yml")).toBe(".gitlab-ci.yml");
    expect(encodeFilePath("deco/blocks/page.v2.json")).toBe(
      "deco%2Fblocks%2Fpage.v2.json",
    );
  });

  test("drops a leading slash so /README.md and README.md address the same file", () => {
    expect(encodeFilePath("/README.md")).toBe("README.md");
    expect(encodeFilePath("//src/app.ts")).toBe("src%2Fapp.ts");
  });

  test("encodes spaces and hashes", () => {
    expect(encodeFilePath("docs/my file#1.md")).toBe("docs%2Fmy%20file%231.md");
  });
});

describe("mapGitlabProject", () => {
  const project = {
    id: 4242,
    name: "project",
    path: "project",
    path_with_namespace: "group/sub/project",
    default_branch: "main",
    web_url: "https://gitlab.com/group/sub/project",
    visibility: "internal",
    description: "A project",
    last_activity_at: "2026-09-01T10:00:00.000Z",
    extra_field_gitlab_added: true,
  };

  test("maps the project payload to a RepoSummary", () => {
    expect(mapGitlabProject(project, "gitlab.com")).toEqual({
      ref: {
        provider: "gitlab",
        host: "gitlab.com",
        path: "group/sub/project",
      },
      externalId: "4242",
      defaultBranch: "main",
      webUrl: "https://gitlab.com/group/sub/project",
      visibility: "internal",
      description: "A project",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
  });

  test("uses path_with_namespace as the RepoRef path, not name or path", () => {
    const summary = mapGitlabProject(project, "gitlab.com");
    expect(summary.ref.path).toBe("group/sub/project");
  });

  test("nulls optional fields an empty project lacks", () => {
    const summary = mapGitlabProject(
      {
        id: 1,
        path_with_namespace: "g/empty",
        visibility: "private",
        default_branch: null,
        description: null,
        last_activity_at: null,
      },
      "git.corp.io",
    );
    expect(summary.defaultBranch).toBeNull();
    expect(summary.description).toBeNull();
    expect(summary.updatedAt).toBeNull();
    expect(summary.webUrl).toBe("https://git.corp.io/g/empty");
  });

  test("keeps the host it was given so self-managed refs round-trip", () => {
    const summary = mapGitlabProject(project, "git.corp.io");
    expect(summary.ref.host).toBe("git.corp.io");
  });

  test("rejects a payload missing the identity fields", () => {
    expect(() => mapGitlabProject({ id: 1 }, "gitlab.com")).toThrow();
    expect(() =>
      mapGitlabProject(
        { id: 1, path_with_namespace: "g/p", visibility: "secret" },
        "gitlab.com",
      ),
    ).toThrow();
  });
});

describe("gitlabRetryAfterMs", () => {
  const now = 1_700_000_000_000;

  test("prefers Retry-After in seconds", () => {
    const headers = new Headers({
      "Retry-After": "30",
      "RateLimit-Reset": String(now / 1000 + 600),
    });
    expect(gitlabRetryAfterMs(headers, now)).toBe(30_000);
  });

  test("accepts an HTTP-date Retry-After", () => {
    const headers = new Headers({
      "Retry-After": new Date(now + 45_000).toUTCString(),
    });
    expect(gitlabRetryAfterMs(headers, now)).toBe(45_000);
  });

  test("falls back to RateLimit-Reset (epoch seconds)", () => {
    const headers = new Headers({ "RateLimit-Reset": String(now / 1000 + 90) });
    expect(gitlabRetryAfterMs(headers, now)).toBe(90_000);
  });

  test("clamps a reset in the past to zero", () => {
    const headers = new Headers({ "RateLimit-Reset": String(now / 1000 - 5) });
    expect(gitlabRetryAfterMs(headers, now)).toBe(0);
  });

  test("returns null when GitLab gave no hint", () => {
    expect(gitlabRetryAfterMs(new Headers(), now)).toBeNull();
    expect(
      gitlabRetryAfterMs(new Headers({ "Retry-After": "soon" }), now),
    ).toBeNull();
  });
});
