import { describe, expect, test } from "bun:test";
import {
  bitbucketArchiveUrl,
  encodeSrcPath,
  mapBitbucketRepository,
  repositoryApiPath,
  splitBitbucketPath,
} from "./client";

describe("splitBitbucketPath", () => {
  test("workspace and slug", () => {
    expect(splitBitbucketPath("acme/site")).toEqual({
      workspace: "acme",
      slug: "site",
    });
  });
  test("refuses anything but two segments", () => {
    expect(() => splitBitbucketPath("site")).toThrow(/workspace\/repo_slug/);
    expect(() => splitBitbucketPath("a/b/c")).toThrow(/workspace\/repo_slug/);
  });
});

describe("repositoryApiPath", () => {
  test("encodes each segment", () => {
    expect(repositoryApiPath({ path: "acme/site" })).toBe(
      "/repositories/acme/site",
    );
    expect(repositoryApiPath({ path: "acme/my site" })).toBe(
      "/repositories/acme/my%20site",
    );
  });
});

describe("encodeSrcPath", () => {
  test("encodes segments and keeps the slashes", () => {
    expect(encodeSrcPath("src/app.ts")).toBe("src/app.ts");
    expect(encodeSrcPath("/README.md")).toBe("README.md");
    expect(encodeSrcPath("docs/a b#c.md")).toBe("docs/a%20b%23c.md");
  });
});

describe("bitbucketArchiveUrl", () => {
  test("is the web host's download, pinned to the ref", () => {
    const repo = {
      provider: "bitbucket" as const,
      host: "bitbucket.org",
      path: "acme/site",
    };
    expect(bitbucketArchiveUrl(repo, "main")).toBe(
      "https://bitbucket.org/acme/site/get/main.tar.gz",
    );
    expect(bitbucketArchiveUrl(repo, "feat/x")).toBe(
      "https://bitbucket.org/acme/site/get/feat%2Fx.tar.gz",
    );
  });
});

describe("mapBitbucketRepository", () => {
  const payload = {
    uuid: "{1111-2222}",
    full_name: "Acme/Site",
    is_private: true,
    description: "Storefront",
    mainbranch: { name: "main" },
    links: { html: { href: "https://bitbucket.org/Acme/Site" } },
    updated_on: "2026-09-01T00:00:00Z",
  };

  test("maps the repository payload to a RepoSummary", () => {
    expect(mapBitbucketRepository(payload, "bitbucket.org")).toEqual({
      ref: { provider: "bitbucket", host: "bitbucket.org", path: "Acme/Site" },
      externalId: "{1111-2222}",
      defaultBranch: "main",
      webUrl: "https://bitbucket.org/Acme/Site",
      visibility: "private",
      description: "Storefront",
      updatedAt: "2026-09-01T00:00:00Z",
    });
  });

  test("a public repository, missing the optional fields", () => {
    const summary = mapBitbucketRepository(
      { uuid: "{x}", full_name: "acme/empty", is_private: false },
      "bitbucket.org",
    );
    expect(summary.visibility).toBe("public");
    expect(summary.defaultBranch).toBeNull();
    expect(summary.description).toBeNull();
    expect(summary.updatedAt).toBeNull();
    expect(summary.webUrl).toBe("https://bitbucket.org/acme/empty");
  });

  test("rejects a payload missing the identity fields", () => {
    expect(() =>
      mapBitbucketRepository({ full_name: "acme/site" }, "bitbucket.org"),
    ).toThrow();
  });
});
