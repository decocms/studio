import { describe, expect, it } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import {
  resolveRepositoryForProject,
  resolveSiteRepositoryId,
} from "./resolve-site-repository";

const repository = {
  url: "https://github.com/example-org/example-site",
  owner: "example-org",
  name: "example-site",
};

function contextWith(
  projects: unknown[],
  options: {
    byId?: Record<string, string>;
    byPath?: Record<string, string>;
    link?: { organizationId: string | null; projectId: string | null };
  } = {},
): StudioContext {
  return {
    storage: {
      virtualMcps: { list: async () => projects },
      orgSites: { getBySlug: async () => options.link ?? null },
      repositories: {
        get: async (id: string) =>
          options.byId?.[id] ? { id: options.byId[id] } : null,
        findByRef: async (_org: string, ref: { path: string }) =>
          options.byPath?.[ref.path.toLowerCase()]
            ? { id: options.byPath[ref.path.toLowerCase()] }
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
      {
        byPath: { "example-org/example-site": "repo-2" },
      },
    );

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBe("repo-2");
  });

  it("follows the org_sites link to a project whose own slug differs", async () => {
    const ctx = contextWith(
      [{ id: "vm-1", title: "another-name", metadata: { repository } }],
      {
        byPath: { "example-org/example-site": "repo-3" },
        link: { organizationId: "org-1", projectId: "vm-1" },
      },
    );

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).resolves.toBe("repo-3");
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

  it("rejects a site the organization does not own", async () => {
    const ctx = contextWith([
      { title: "other-site", metadata: { repository } },
    ]);

    await expect(
      resolveSiteRepositoryId(ctx, "org-1", "example-site"),
    ).rejects.toThrow("Site not found in organization");
  });
});

describe("resolveRepositoryForProject", () => {
  it("resolves the binding's repository row for an already-resolved project", async () => {
    const ctx = contextWith([], {
      byId: { "repo-1": "repo-1" },
    });

    await expect(
      resolveRepositoryForProject(ctx, "org-1", {
        metadata: { repository: { ...repository, repositoryId: "repo-1" } },
      }),
    ).resolves.toEqual({ id: "repo-1" });
  });

  it("returns null for a project with no repository binding", async () => {
    const ctx = contextWith([]);

    await expect(
      resolveRepositoryForProject(ctx, "org-1", { metadata: null }),
    ).resolves.toBeNull();
  });
});
