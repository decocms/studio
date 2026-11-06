import { describe, expect, it } from "bun:test";
import { isBlocksV8Project } from "@decocms/shared/blocks-major";
import { ForbiddenError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";
import {
  blocksV8SwitchPatch,
  refuseBlocksV8MetadataWrite,
} from "./blocks-v8-switch";
import { COLLECTION_VIRTUAL_MCP_CREATE } from "./create";
import { COLLECTION_VIRTUAL_MCP_UPDATE } from "./update";

const ORG = "org_1";

/**
 * One project in memory behind the update tool, as the caller with `role`
 * (an org admin, or a member).
 */
function setup(role: string, metadata: Record<string, unknown> | null) {
  const row = {
    id: "vir_1",
    organization_id: ORG,
    title: "Acme",
    metadata,
    connections: [],
  };
  const writes: Array<{ kind: "update" | "patch"; value: unknown }> = [];
  const virtualMcps = {
    findById: async (id: string) => (id === row.id ? { ...row } : null),
    update: async (_id: string, _by: string, data: { metadata?: unknown }) => {
      writes.push({ kind: "update", value: data });
      if (data.metadata !== undefined) {
        row.metadata = data.metadata as Record<string, unknown> | null;
      }
      return { ...row };
    },
    patchMetadata: async (p: {
      set: Record<string, unknown>;
      unset: string[];
    }) => {
      writes.push({ kind: "patch", value: { set: p.set, unset: p.unset } });
      const next = { ...(row.metadata ?? {}), ...p.set };
      for (const key of p.unset) delete next[key];
      row.metadata = next;
      return true;
    },
  };
  const ctx = {
    auth: {
      user: { id: "usr_1", role },
      permissions: {},
      permissionsOrganizationId: ORG,
    },
    organization: { id: ORG, slug: "acme", name: "Acme", role },
    access: { check: async () => {}, getRole: () => role },
    storage: { virtualMcps },
  } as unknown as StudioContext;
  const update = (data: Record<string, unknown>) =>
    COLLECTION_VIRTUAL_MCP_UPDATE.handler(
      { id: row.id, data } as never,
      ctx,
    ) as Promise<{ item: { metadata: Record<string, unknown> | null } }>;
  return { row, writes, update, ctx };
}

describe("the Blocks v8 site switch on COLLECTION_VIRTUAL_MCP_UPDATE", () => {
  it("an org admin turns it on and off with blocksV8", async () => {
    for (const role of ["owner", "admin"]) {
      const t = setup(role, { instructions: "keep" });
      const on = await t.update({ blocksV8: true });
      expect(isBlocksV8Project(on.item.metadata)).toBe(true);
      expect(t.row.metadata).toEqual({ instructions: "keep", blocksV8: true });
      const off = await t.update({ blocksV8: false });
      // Off is the key gone: exactly the v7 project it was.
      expect(off.item.metadata).toEqual({ instructions: "keep" });
      expect(t.writes.filter((w) => w.kind === "patch")).toEqual([
        { kind: "patch", value: { set: { blocksV8: true }, unset: [] } },
        { kind: "patch", value: { set: {}, unset: ["blocksV8"] } },
      ]);
    }
  });

  it("a member can't, and nothing is written", async () => {
    const t = setup("user", {});
    await expect(t.update({ blocksV8: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const v8 = setup("user", { blocksV8: true });
    await expect(v8.update({ blocksV8: false })).rejects.toThrow(
      /owners and admins/,
    );
    expect([...t.writes, ...v8.writes]).toEqual([]);
  });

  it("a member's no-op blocksV8 and other edits still save", async () => {
    const t = setup("user", { blocksV8: true });
    await t.update({ blocksV8: true, title: "Acme 2" });
    expect(t.writes.map((w) => w.kind)).toEqual(["update"]);
    expect(isBlocksV8Project(t.row.metadata)).toBe(true);
  });

  it("refuses setting or clearing it through metadata, even for an admin", async () => {
    const off = setup("owner", {});
    await expect(
      off.update({ metadata: { blocksV8: true } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const on = setup("owner", { blocksV8: true });
    await expect(on.update({ metadata: { blocksV8: false } })).rejects.toThrow(
      /"Blocks v8 site" switch/,
    );
    expect([...off.writes, ...on.writes]).toEqual([]);
  });

  it("a metadata write that echoes it, or clears metadata, keeps it", async () => {
    const t = setup("user", { blocksV8: true, instructions: "a" });
    await t.update({ metadata: { blocksV8: true, instructions: "b" } });
    expect(t.row.metadata).toEqual({ blocksV8: true, instructions: "b" });
    await t.update({ metadata: { instructions: "c" } });
    expect(isBlocksV8Project(t.row.metadata)).toBe(true);
    await t.update({ metadata: null });
    expect(t.row.metadata).toEqual({ blocksV8: true });
  });

  it("a new project can't start as a v8 site", async () => {
    const { ctx } = setup("owner", null);
    await expect(
      COLLECTION_VIRTUAL_MCP_CREATE.handler(
        {
          data: {
            title: "New",
            connections: [],
            metadata: { blocksV8: true },
          },
        } as never,
        ctx,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("blocksV8SwitchPatch / refuseBlocksV8MetadataWrite", () => {
  it("patch only the key, and nothing when it already matches", () => {
    expect(blocksV8SwitchPatch({}, true)).toEqual({
      set: { blocksV8: true },
      unset: [],
    });
    expect(blocksV8SwitchPatch({ blocksV8: true }, false)).toEqual({
      set: {},
      unset: ["blocksV8"],
    });
    expect(blocksV8SwitchPatch({ blocksV8: true }, true)).toBeNull();
    expect(blocksV8SwitchPatch(null, false)).toBeNull();
    // A stale `blocksMajor` marker is not the switch.
    expect(blocksV8SwitchPatch({ blocksMajor: 8 }, false)).toBeNull();
  });

  it("let metadata without the key, or with the stored value, through", () => {
    expect(() => refuseBlocksV8MetadataWrite({}, { a: 1 })).not.toThrow();
    expect(() => refuseBlocksV8MetadataWrite({}, null)).not.toThrow();
    expect(() =>
      refuseBlocksV8MetadataWrite({}, { blocksV8: false }),
    ).not.toThrow();
    expect(() =>
      refuseBlocksV8MetadataWrite({ blocksV8: true }, { blocksV8: true }),
    ).not.toThrow();
    expect(() => refuseBlocksV8MetadataWrite({}, { blocksV8: true })).toThrow(
      ForbiddenError,
    );
  });
});
