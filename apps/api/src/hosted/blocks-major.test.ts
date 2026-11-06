import { describe, expect, it } from "bun:test";
import {
  BLOCKS_MAJOR_METADATA_KEY,
  CMS_SCHEMA_PUSH_METADATA_KEY,
} from "@decocms/shared/blocks-major";
import { projectPackagePath } from "./blocks-major";
import {
  type BlocksMajorStorage,
  syncBlocksMajorMarker,
} from "./blocks-major-marker";

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

const push = { site: "acme", sha256: "e1" };
const v8 = { isV8: true, ...push };
const v7 = { isV8: false, ...push };
const pushed = { blocksMajor: 8, cmsSchemaPush: push };

describe("syncBlocksMajorMarker", () => {
  it("sets the marker and its push record when the pushed schema is v8", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(projects, project({}), v8, "user");
    expect(patches).toEqual([
      {
        id: "vmcp",
        organizationId: "org",
        set: pushed,
        unset: [],
        by: "user",
      },
    ]);
  });

  it("records the push on a stale marker (one without a push record)", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(
      projects,
      project({ blocksMajor: 8 }),
      v8,
      "user",
    );
    expect(patches.map((p) => p.set)).toEqual([pushed]);
  });

  it("records a newer push of a v8 schema", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(
      projects,
      project(pushed),
      { ...v8, sha256: "e2" },
      "user",
    );
    expect(patches.map((p) => p.set)).toEqual([
      { blocksMajor: 8, cmsSchemaPush: { site: "acme", sha256: "e2" } },
    ]);
  });

  it("clears both when the pushed schema is no longer v8, a stale marker too", async () => {
    for (const metadata of [
      pushed,
      { blocksMajor: 8 },
      { cmsSchemaPush: push },
    ]) {
      const { projects, patches } = recordingStorage();
      await syncBlocksMajorMarker(projects, project(metadata), v7, "user");
      expect(patches).toEqual([
        {
          id: "vmcp",
          organizationId: "org",
          set: {},
          unset: [BLOCKS_MAJOR_METADATA_KEY, CMS_SCHEMA_PUSH_METADATA_KEY],
          by: "user",
        },
      ]);
    }
  });

  it("writes nothing when the stored keys already match", async () => {
    const { projects, patches } = recordingStorage();
    await syncBlocksMajorMarker(projects, project(pushed), v8, "user");
    await syncBlocksMajorMarker(projects, project(null), v7, "user");
    await syncBlocksMajorMarker(projects, project({ x: 1 }), v7, "user");
    expect(patches).toEqual([]);
  });

  it("reports whether the stored keys match", async () => {
    const { projects } = recordingStorage();
    expect(await syncBlocksMajorMarker(projects, project({}), v8, "user")).toBe(
      true,
    );
    expect(
      await syncBlocksMajorMarker(projects, project(pushed), v8, "user"),
    ).toBe(true);
    const missing: BlocksMajorStorage = { patchMetadata: async () => false };
    expect(await syncBlocksMajorMarker(missing, project({}), v8, "user")).toBe(
      false,
    );
  });

  it("swallows a failed write and reports it", async () => {
    const { projects } = recordingStorage(true);
    await expect(
      syncBlocksMajorMarker(projects, project({}), v8, "user"),
    ).resolves.toBe(false);
  });
});

describe("projectPackagePath", () => {
  it("trims slashes and treats empty as the repo root", () => {
    expect(projectPackagePath({ runtime: { path: "/a/b/" } })).toBe("a/b");
    expect(projectPackagePath({ runtime: { path: "/" } })).toBeNull();
    expect(projectPackagePath(null)).toBeNull();
  });
});
