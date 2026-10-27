import { describe, expect, it } from "bun:test";
import { BLOCKS_MAJOR_METADATA_KEY } from "@decocms/shared/blocks-major";
import {
  type BlocksMajorStorage,
  refreshBlocksMajorMarkerWithin,
  metadataForThreadRuntime,
  projectPackagePath,
  refreshBlocksMajorMarker,
  threadRuntimeAwaitsBlocksMajor,
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
        unset: [BLOCKS_MAJOR_METADATA_KEY],
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

  it("reports whether the stored marker matches", async () => {
    const { projects } = recordingStorage();
    expect(
      await syncBlocksMajorMarker(projects, project({}), true, "user"),
    ).toBe(true);
    expect(
      await syncBlocksMajorMarker(
        projects,
        project({ blocksMajor: 8 }),
        true,
        "user",
      ),
    ).toBe(true);
    const missing: BlocksMajorStorage = { patchMetadata: async () => false };
    expect(
      await syncBlocksMajorMarker(missing, project({}), true, "user"),
    ).toBe(false);
  });

  it("swallows a failed write and reports it", async () => {
    const { projects } = recordingStorage(true);
    await expect(
      syncBlocksMajorMarker(projects, project({}), true, "user"),
    ).resolves.toBe(false);
  });
});

describe("refreshBlocksMajorMarkerWithin", () => {
  it("marks a project whose repo's main is v8, in any org", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    const isV8 = await refreshBlocksMajorMarkerWithin({
      projects,
      project: project({ siteSlug: "acme" }),
      by: "user",
      client: async () => git.client,
    });
    expect(isV8).toBe(true);
    expect(patches.map((p) => p.set)).toEqual([{ blocksMajor: 8 }]);
  });

  it("reads the schema under the site's folder", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ "site/.deco/schema.gen.json": SCHEMA_TEXT });
    await refreshBlocksMajorMarkerWithin({
      projects,
      project: project({ runtime: { path: "/site/" } }),
      by: "user",
      client: async () => git.client,
    });
    expect(patches).toHaveLength(1);
  });

  it("never marks a v7 site", async () => {
    const { projects, patches } = recordingStorage();
    const v7Repos: Record<string, string>[] = [
      { ".deco/schema.gen.json": V7_SCHEMA },
      { ".deco/schema.gen.json": '{"blocksMajor":7}' },
      // Only `.deco/schema.gen.json` is read, never `meta.gen.json`.
      { ".deco/meta.gen.json": SCHEMA_TEXT },
      { ".deco/schema.gen.json": "{" },
      {},
    ];
    for (const files of v7Repos) {
      const git = fakeRepo(files);
      const isV8 = await refreshBlocksMajorMarkerWithin({
        projects,
        project: project({}),
        by: "user",
        client: async () => git.client,
      });
      expect(isV8).toBe(false);
    }
    expect(patches).toEqual([]);
  });

  it("clears the marker when main is back on v7", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": V7_SCHEMA });
    await refreshBlocksMajorMarkerWithin({
      projects,
      project: project({ blocksMajor: 8 }),
      by: "user",
      client: async () => git.client,
    });
    expect(patches.map((p) => p.unset)).toEqual([[BLOCKS_MAJOR_METADATA_KEY]]);
  });

  it("does nothing for a project without a repository", async () => {
    const { projects, patches } = recordingStorage();
    const isV8 = await refreshBlocksMajorMarkerWithin({
      projects,
      project: project({}),
      by: "user",
      client: async () => null,
    });
    expect(isV8).toBeNull();
    expect(patches).toEqual([]);
  });

  it("never throws when the repo read fails", async () => {
    const { projects, patches } = recordingStorage();
    await expect(
      refreshBlocksMajorMarkerWithin({
        projects,
        project: project({}),
        by: "user",
        client: async () => {
          throw new Error("no credential");
        },
      }),
    ).resolves.toBeNull();
    expect(patches).toEqual([]);
  });

  it("answers null when the marker write failed", async () => {
    const { projects } = recordingStorage(true);
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    expect(
      await refreshBlocksMajorMarker({
        projects,
        project: project({}),
        by: "user",
        client: async () => git.client,
      }),
    ).toBeNull();
    // Already marked: nothing to write, so the answer stands.
    expect(
      await refreshBlocksMajorMarker({
        projects,
        project: project({ blocksMajor: 8 }),
        by: "user",
        client: async () => git.client,
      }),
    ).toBe(true);
  });

  it("re-reads only main's head while it is unchanged", async () => {
    const { projects } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    let treeReads = 0;
    const client = {
      ...git.client,
      getEntriesAtPaths: (
        ...args: Parameters<typeof git.client.getEntriesAtPaths>
      ) => {
        treeReads++;
        return git.client.getEntriesAtPaths(...args);
      },
    };
    const deps = {
      projects,
      project: project({ blocksMajor: 8 }),
      by: "user",
      client: async () => client,
    };
    expect(await refreshBlocksMajorMarker(deps)).toBe(true);
    expect(await refreshBlocksMajorMarker(deps)).toBe(true);
    expect(treeReads).toBe(1);
    git.pushDirect({ ".deco/schema.gen.json": V7_SCHEMA });
    expect(await refreshBlocksMajorMarker(deps)).toBe(false);
    expect(treeReads).toBe(2);
  });

  it("stops waiting after the timeout; the answer still lands", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isV8 = await refreshBlocksMajorMarkerWithin(
      {
        projects,
        project: project({}),
        by: "user",
        client: async () => {
          await gate;
          return git.client;
        },
      },
      10,
    );
    expect(isV8).toBeNull();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches.map((p) => p.set)).toEqual([{ blocksMajor: 8 }]);
  });
});

describe("metadataForThreadRuntime", () => {
  const repository = { owner: "acme", name: "site" };
  const previewServerUrl = "https://acme.example.com";

  it("runs the check only when the answer decides the stamp", () => {
    expect(
      threadRuntimeAwaitsBlocksMajor({ repository, previewServerUrl }),
    ).toBe(true);
    for (const metadata of [
      null,
      { previewServerUrl },
      { repository },
      { repository, previewServerUrl, blocksMajor: 8 },
      { repository, previewServerUrl, fastPreview: true },
    ]) {
      expect(threadRuntimeAwaitsBlocksMajor(metadata)).toBe(false);
    }
  });

  it("adds the marker a v8 main just got, so the thread is cms", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    const metadata = await metadataForThreadRuntime({
      projects,
      project: project({ repository, previewServerUrl }),
      by: "user",
      client: async () => git.client,
    });
    expect(metadata).toEqual({ repository, previewServerUrl, blocksMajor: 8 });
    expect(patches.map((p) => p.set)).toEqual([{ blocksMajor: 8 }]);
  });

  it("leaves a v7 project's metadata as stored", async () => {
    const { projects, patches } = recordingStorage();
    const git = fakeRepo({ ".deco/schema.gen.json": V7_SCHEMA });
    const stored = { repository, previewServerUrl };
    expect(
      await metadataForThreadRuntime({
        projects,
        project: project(stored),
        by: "user",
        client: async () => git.client,
      }),
    ).toBe(stored);
    expect(patches).toEqual([]);
  });

  it("never reads the repo when the answer can't change the stamp", async () => {
    const { projects } = recordingStorage();
    let reads = 0;
    for (const stored of [
      { repository },
      { previewServerUrl },
      { repository, previewServerUrl, fastPreview: true },
      { repository, previewServerUrl, blocksMajor: 8 },
    ]) {
      expect(
        await metadataForThreadRuntime({
          projects,
          project: project(stored),
          by: "user",
          client: async () => {
            reads++;
            return null;
          },
        }),
      ).toBe(stored);
    }
    expect(reads).toBe(0);
  });

  it("keeps the stored metadata when the marker write failed", async () => {
    const { projects } = recordingStorage(true);
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    const stored = { repository, previewServerUrl };
    expect(
      await metadataForThreadRuntime({
        projects,
        project: project(stored),
        by: "user",
        client: async () => git.client,
      }),
    ).toBe(stored);
  });
});

describe("projectPackagePath", () => {
  it("trims slashes and treats empty as the repo root", () => {
    expect(projectPackagePath({ runtime: { path: "/a/b/" } })).toBe("a/b");
    expect(projectPackagePath({ runtime: { path: "/" } })).toBeNull();
    expect(projectPackagePath(null)).toBeNull();
  });
});
