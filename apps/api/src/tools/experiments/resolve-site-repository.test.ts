import { describe, expect, it } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { resolveSiteRepositoryId } from "./resolve-site-repository";

const repository = {
  url: "https://github.com/example-org/example-site",
  owner: "example-org",
  name: "example-site",
};

function contextWith(
  projects: unknown[],
  repositories: {
    byId?: Record<string, string>;
    byPath?: Record<string, string>;
  } = {},
): StudioContext {
  return {
    storage: {
      virtualMcps: { list: async () => projects },
      repositories: {
        get: async (id: string) =>
          repositories.byId?.[id] ? { id: repositories.byId[id] } : null,
        findByRef: async (_org: string, ref: { path: string }) =>
          repositories.byPath?.[ref.path.toLowerCase()]
            ? { id: repositories.byPath[ref.path.toLowerCase()] }
            : null,
      },
    },
  } as unknown as StudioContext;
}

describe("resolveSiteRepositoryId", () => {
  it("resolves the binding's repository row", async () => {
    const ctx = contextWith(
      [
        {
          title: "example-site",
          metadata: { repository: { ...repository, repositoryId: "repo-1" } },
        },
      ],
      { byId: { "repo-1": "repo-1" } },
    );

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBe("repo-1");
  });

  it("falls back to the org repository matching an imported binding", async () => {
    const ctx = contextWith(
      [{ title: "example-site", metadata: { repository } }],
      { byPath: { "example-org/example-site": "repo-2" } },
    );

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBe("repo-2");
  });

  it("ignores the raw storage key, which no read path returns", async () => {
    const ctx = contextWith(
      [{ title: "example-site", metadata: { githubRepo: repository } }],
      { byPath: { "example-org/example-site": "repo-2" } },
    );

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBeNull();
  });

  it("returns null when the binding matches no repository row", async () => {
    const ctx = contextWith([
      { title: "example-site", metadata: { repository } },
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
