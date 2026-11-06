import { describe, expect, it } from "bun:test";
import { BLOCKS_MAJOR_METADATA_KEY } from "@decocms/shared/blocks-major";
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

describe("projectPackagePath", () => {
  it("trims slashes and treats empty as the repo root", () => {
    expect(projectPackagePath({ runtime: { path: "/a/b/" } })).toBe("a/b");
    expect(projectPackagePath({ runtime: { path: "/" } })).toBeNull();
    expect(projectPackagePath(null)).toBeNull();
  });
});
