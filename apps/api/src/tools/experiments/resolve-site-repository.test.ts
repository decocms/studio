import { describe, expect, it } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import {
  resolveRepositoryIdForProject,
  resolveSiteRepositoryId,
} from "./resolve-site-repository";

function contextWith(projects: unknown[]): StudioContext {
  return {
    storage: { virtualMcps: { list: async () => projects } },
  } as unknown as StudioContext;
}

const repository = {
  url: "https://github.com/example-org/example-site",
  owner: "example-org",
  name: "example-site",
  repositoryId: "repo-1",
};

describe("resolveSiteRepositoryId", () => {
  it("reads the normalized repository binding", async () => {
    const ctx = contextWith([
      { title: "example-site", metadata: { repository } },
    ]);

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBe("repo-1");
  });

  it("ignores the raw storage key, which no read path returns", async () => {
    const ctx = contextWith([
      { title: "example-site", metadata: { githubRepo: repository } },
    ]);

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBeNull();
  });

  it("returns null for a binding with no repository row", async () => {
    const ctx = contextWith([
      {
        title: "example-site",
        metadata: { repository: { ...repository, repositoryId: undefined } },
      },
    ]);

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBeNull();
  });

  it("returns null when no project matches the site", async () => {
    const ctx = contextWith([
      { title: "other-site", metadata: { repository } },
    ]);

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBeNull();
  });
});

describe("resolveRepositoryIdForProject", () => {
  it("resolves the binding's repository row for an already-resolved project", async () => {
    const ctx = contextWith([], {
      byId: { "repo-1": "repo-1" },
    });

    await expect(
      resolveRepositoryIdForProject(ctx, "org-1", {
        metadata: { repository: { ...repository, repositoryId: "repo-1" } },
      }),
    ).resolves.toBe("repo-1");
  });

  it("returns null for a project with no repository binding", async () => {
    const ctx = contextWith([]);

    await expect(
      resolveRepositoryIdForProject(ctx, "org-1", { metadata: null }),
    ).resolves.toBeNull();
  });
});
