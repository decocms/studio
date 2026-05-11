import { describe, expect, it, test } from "bun:test";
import {
  VirtualMCPEntitySchema,
  VirtualMcpUILayoutSchema,
  VirtualMCPUpdateDataSchema,
  VmMapEntrySchema,
} from "./virtual-mcp";

describe("VirtualMcpUILayoutSchema tabs", () => {
  it("parses a tabs array with ext-app view", () => {
    const parsed = VirtualMcpUILayoutSchema.parse({
      tabs: [
        {
          id: "analytics",
          title: "Analytics",
          icon: "BarChart",
          view: { type: "ext-app", appId: "app_abc", args: { range: "7d" } },
        },
      ],
      defaultMainView: null,
    });
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.tabs?.[0]!.view.type).toBe("ext-app");
    expect(parsed.tabs?.[0]!.view.appId).toBe("app_abc");
  });

  it("accepts tabs omitted (backwards compatible)", () => {
    const parsed = VirtualMcpUILayoutSchema.parse({
      defaultMainView: null,
    });
    expect(parsed.tabs).toBeUndefined();
  });

  it("rejects a tab view with unknown type", () => {
    const result = VirtualMcpUILayoutSchema.safeParse({
      tabs: [
        {
          id: "bad",
          title: "Bad",
          view: { type: "mystery", appId: "app_x" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

test("metadata.runtime is typed and round-trips through parse", () => {
  const parsed = VirtualMCPEntitySchema.parse({
    id: "x",
    title: "x",
    description: null,
    icon: null,
    created_at: "t",
    updated_at: "t",
    created_by: "u",
    organization_id: "o",
    status: "active",
    pinned: false,
    metadata: {
      instructions: null,
      runtime: { selected: "pnpm", port: "3000" },
    },
    connections: [],
  });
  expect(parsed.metadata.runtime?.selected).toBe("pnpm");
  expect(parsed.metadata.runtime?.port).toBe("3000");
});

test("metadata.runtime accepts null/empty values", () => {
  const parsed = VirtualMCPEntitySchema.parse({
    id: "x",
    title: "x",
    description: null,
    icon: null,
    created_at: "t",
    updated_at: "t",
    created_by: "u",
    organization_id: "o",
    status: "active",
    pinned: false,
    metadata: {
      instructions: null,
      runtime: { selected: null, port: null },
    },
    connections: [],
  });
  expect(parsed.metadata.runtime?.selected).toBeNull();
  expect(parsed.metadata.runtime?.port).toBeNull();
});

test("VirtualMCPUpdateDataSchema accepts metadata.runtime", () => {
  const parsed = VirtualMCPUpdateDataSchema.parse({
    metadata: { runtime: { selected: "bun", port: null } },
  });
  expect(parsed.metadata?.runtime?.selected).toBe("bun");
  expect(parsed.metadata?.runtime?.port).toBeNull();
});

test("VmMapEntry.startedWith is optional with nullable packageManager/port/path", () => {
  const a = VmMapEntrySchema.parse({ vmId: "v", previewUrl: null });
  expect(a.startedWith).toBeUndefined();
  const b = VmMapEntrySchema.parse({
    vmId: "v",
    previewUrl: null,
    startedWith: { packageManager: "pnpm", port: "3000", path: "apps/web" },
  });
  expect(b.startedWith?.packageManager).toBe("pnpm");
  expect(b.startedWith?.port).toBe("3000");
  expect(b.startedWith?.path).toBe("apps/web");
  const c = VmMapEntrySchema.parse({
    vmId: "v",
    previewUrl: null,
    startedWith: { packageManager: null, port: null, path: null },
  });
  expect(c.startedWith?.packageManager).toBeNull();
  expect(c.startedWith?.port).toBeNull();
  expect(c.startedWith?.path).toBeNull();
});
