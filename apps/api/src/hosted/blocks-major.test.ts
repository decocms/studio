import { describe, expect, it } from "bun:test";
import {
  type BlocksMajorStorage,
  markBlocksV8OnCreate,
  projectPackagePath,
  syncBlocksMajorMarker,
} from "./blocks-major";
import { fakeRepo, SCHEMA_TEXT } from "./hosted-test-helpers";

type Patch = Parameters<BlocksMajorStorage["patchMetadata"]>[0];

function recordingStorage(fail = false) {
  const patches: Patch[] = [];
  const projects: BlocksMajorStorage = {
    patchMetadata: async (params) => {
      if (fail) throw new Error("db down");
      patches.push(params);
      return true;
    },
  };
  return { projects, patches };
}

const project = (metadata: Record<string, unknown> | null) => ({
  id: "vmcp",
  organizationId: "org",
  metadata,
});

const V7_SCHEMA = '{\n  "definitions": {},\n  "root": {}\n}\n';

describe("syncBlocksMajorMarker", () => {
  it("sets the marker when main is v8 and it is missing", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(projects, project({}), true, "user");
    expect(patches).toEqual([
      {
        id: "vmcp",
        organizationId: "org",
        set: { blocksMajor: 8 },
        unset: [],
        by: "user",
      },
    ]);
  });

  it("clears the marker when main is no longer v8", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(
      projects,
      project({ blocksMajor: 8 }),
      false,
      "user",
    );
    expect(patches).toEqual([
      {
        id: "vmcp",
        organizationId: "org",
        set: {},
        unset: ["blocksMajor"],
        by: "user",
      },
    ]);
  });

  it("writes nothing when the marker already matches", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(
      projects,
      project({ blocksMajor: 8 }),
      true,
      "user",
    );
    await syncBlocksMajorMarker(projects, project(null), false, "user");
    expect(patches).toEqual([]);
  });

  it("swallows a failed write", async () => {
    const { projects } = recordingStorage(true);
    await expect(
      syncBlocksMajorMarker(projects, project({}), true, "user"),
    ).resolves.toBeUndefined();
  });
});

describe("markBlocksV8OnCreate", () => {
  const flagOn = async () => ({ site_editor_content_protocol: true });

  it("marks a project whose repo's main is v8", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    await markBlocksV8OnCreate({
      projects,
      project: project({ siteSlug: "acme" }),
      by: "user",
      flags: flagOn,
      client: async () => git.client,
    });
    expect(patches.map((p) => p.set)).toEqual([{ blocksMajor: 8 }]);
  });

  it("reads the schema under the site's folder", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ "site/.deco/schema.gen.json": SCHEMA_TEXT });
    await markBlocksV8OnCreate({
      projects,
      project: project({ runtime: { path: "/site/" } }),
      by: "user",
      flags: flagOn,
      client: async () => git.client,
    });
    expect(patches).toHaveLength(1);
  });

  it("never marks a v7 site", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": V7_SCHEMA });
    await markBlocksV8OnCreate({
      projects,
      project: project({}),
      by: "user",
      flags: flagOn,
      client: async () => git.client,
    });
    expect(patches).toEqual([]);
  });

  it("does nothing, not even a read, when the org flag is off", async () => {
    const { projects, patches } = recordingStorage();
    let read = false;
    await markBlocksV8OnCreate({
      projects,
      project: project({}),
      by: "user",
      flags: async () => ({}),
      client: async () => {
        read = true;
        return fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT }).client;
      },
    });
    expect(read).toBe(false);
    expect(patches).toEqual([]);
  });

  it("does nothing for a project without a repository", async () => {
    const { projects, patches } = recordingStorage();
    await markBlocksV8OnCreate({
      projects,
      project: project({}),
      by: "user",
      flags: flagOn,
      client: async () => null,
    });
    expect(patches).toEqual([]);
  });

  it("never throws when the repo read fails", async () => {
    const { projects, patches } = recordingStorage();
    await expect(
      markBlocksV8OnCreate({
        projects,
        project: project({}),
        by: "user",
        flags: flagOn,
        client: async () => {
          throw new Error("no credential");
        },
      }),
    ).resolves.toBeUndefined();
    expect(patches).toEqual([]);
  });
});

describe("projectPackagePath", () => {
  it("trims slashes and treats empty as the repo root", () => {
    expect(projectPackagePath({ runtime: { path: "/a/b/" } })).toBe("a/b");
    expect(projectPackagePath({ runtime: { path: "/" } })).toBeNull();
    expect(projectPackagePath(null)).toBeNull();
  });
});
