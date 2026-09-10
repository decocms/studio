import { describe, expect, test } from "bun:test";
import {
  getActiveGithubRepo,
  projectRepo,
  resolveGithubAttachment,
} from "./github-repo";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";

const baseEntity: VirtualMCPEntity = {
  id: "vmcp-1",
  title: "Test",
  description: null,
  icon: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  created_by: "user-1",
  organization_id: "org-1",
  status: "active",
  pinned: false,
  metadata: { instructions: null },
  connections: [],
};

describe("getActiveGithubRepo", () => {
  test("returns null when virtualMcp is null", () => {
    expect(getActiveGithubRepo(null)).toBeNull();
  });

  test("returns null when virtualMcp is undefined", () => {
    expect(getActiveGithubRepo(undefined)).toBeNull();
  });

  test("returns null when metadata has no githubRepo", () => {
    expect(getActiveGithubRepo(baseEntity)).toBeNull();
  });

  test("returns the repo when there is no connectionId (public-clone mode)", () => {
    const githubRepo = {
      url: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
    };
    const entity: VirtualMCPEntity = {
      ...baseEntity,
      metadata: {
        instructions: null,
        githubRepo,
      },
    };
    expect(getActiveGithubRepo(entity)).toEqual(githubRepo);
  });

  test("returns null when connectionId is not in connections (stale)", () => {
    const entity: VirtualMCPEntity = {
      ...baseEntity,
      metadata: {
        instructions: null,
        githubRepo: {
          url: "https://github.com/owner/repo",
          owner: "owner",
          name: "repo",
          installationId: 123,
          connectionId: "conn-github",
        },
      },
      connections: [
        {
          connection_id: "conn-other",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    };
    expect(getActiveGithubRepo(entity)).toBeNull();
  });

  test("returns githubRepo when connectionId matches a connection", () => {
    const githubRepo = {
      url: "https://github.com/owner/repo",
      owner: "owner",
      name: "repo",
      installationId: 123,
      connectionId: "conn-github",
    };
    const entity: VirtualMCPEntity = {
      ...baseEntity,
      metadata: {
        instructions: null,
        githubRepo,
      },
      connections: [
        {
          connection_id: "conn-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
        {
          connection_id: "conn-other",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    };
    expect(getActiveGithubRepo(entity)).toEqual(githubRepo);
  });
});

describe("resolveGithubAttachment", () => {
  const withRepo = (
    githubRepo: unknown,
    connectionIds: string[] = [],
  ): VirtualMCPEntity => ({
    ...baseEntity,
    metadata: { instructions: null, githubRepo: githubRepo as never },
    connections: connectionIds.map((id) => ({
      connection_id: id,
      selected_tools: null,
      selected_resources: null,
      selected_prompts: null,
    })),
  });

  test("'none' with no repo or no url", () => {
    expect(resolveGithubAttachment(null).status).toBe("none");
    expect(resolveGithubAttachment(baseEntity).status).toBe("none");
    expect(
      resolveGithubAttachment(withRepo({ owner: "a", name: "b" })).status,
    ).toBe("none");
  });

  test("'public-clone' for a template repo with no connection", () => {
    expect(
      resolveGithubAttachment(withRepo({ url: "u", owner: "a", name: "b" }))
        .status,
    ).toBe("public-clone");
  });

  test("'attached' when the connectionId is a live aggregation", () => {
    const r = resolveGithubAttachment(
      withRepo(
        {
          url: "u",
          owner: "a",
          name: "b",
          connectionId: "c",
          installationId: 7,
        },
        ["c"],
      ),
    );
    expect(r.status).toBe("attached");
    if (r.status === "attached") expect(r.connectionId).toBe("c");
  });

  test("'detached' when a stored connectionId is no longer aggregated", () => {
    expect(
      resolveGithubAttachment(
        withRepo({ url: "u", owner: "a", name: "b", connectionId: "c" }, [
          "other",
        ]),
      ).status,
    ).toBe("detached");
  });

  test("'detached' when the pointer is gone but installationId proves prior connection", () => {
    expect(
      resolveGithubAttachment(
        withRepo({ url: "u", owner: "a", name: "b", installationId: 7 }, []),
      ).status,
    ).toBe("detached");
  });
});

/**
 * The join key the project index is built on, so it is worth being explicit
 * about which attachment states count. Every one but `none` does — a project
 * whose repo connection was torn down still OWNS its work, and dropping its
 * cards off the board is a worse answer than listing them under a project
 * whose runs happen to be unable to boot. This is why it is NOT
 * `getActiveGithubRepo`, which answers a different question (can we clone).
 */
describe("projectRepo", () => {
  const withRepo = (githubRepo: unknown, connectionIds: string[] = []) =>
    ({
      ...baseEntity,
      metadata: { instructions: null, githubRepo: githubRepo as never },
      connections: connectionIds.map((id) => ({
        connection_id: id,
        selected_tools: null,
        selected_resources: null,
        selected_prompts: null,
      })),
    }) as VirtualMCPEntity;

  test("null when no repository is attached", () => {
    expect(projectRepo(baseEntity)).toBeNull();
    expect(projectRepo(null)).toBeNull();
    expect(projectRepo(undefined)).toBeNull();
  });

  test("owner/name for every attachment state but 'none'", () => {
    const attached = withRepo(
      { url: "u", owner: "acme", name: "site", connectionId: "c" },
      ["c"],
    );
    const detached = withRepo({
      url: "u",
      owner: "acme",
      name: "site",
      connectionId: "gone",
    });
    const publicClone = withRepo({ url: "u", owner: "acme", name: "site" });

    expect(resolveGithubAttachment(attached).status).toBe("attached");
    expect(resolveGithubAttachment(detached).status).toBe("detached");
    expect(resolveGithubAttachment(publicClone).status).toBe("public-clone");
    for (const entity of [attached, detached, publicClone]) {
      expect(projectRepo(entity)).toBe("acme/site");
    }
  });
});
