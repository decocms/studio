import { describe, expect, it, test } from "bun:test";
import {
  VirtualMCPEntitySchema,
  VirtualMcpUILayoutSchema,
  VirtualMCPUpdateDataSchema,
  SandboxRecordSchema,
  parseVmMapEntry,
  parseBranchMap,
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

test("SandboxRecord.startedWith is optional with nullable packageManager/port/path", () => {
  const a = SandboxRecordSchema.parse({ sandboxHandle: "v", previewUrl: null });
  expect(a.startedWith).toBeUndefined();
  const b = SandboxRecordSchema.parse({
    sandboxHandle: "v",
    previewUrl: null,
    startedWith: { packageManager: "pnpm", port: "3000", path: "apps/web" },
  });
  expect(b.startedWith?.packageManager).toBe("pnpm");
  expect(b.startedWith?.port).toBe("3000");
  expect(b.startedWith?.path).toBe("apps/web");
  const c = SandboxRecordSchema.parse({
    sandboxHandle: "v",
    previewUrl: null,
    startedWith: { packageManager: null, port: null, path: null },
  });
  expect(c.startedWith?.packageManager).toBeNull();
  expect(c.startedWith?.port).toBeNull();
  expect(c.startedWith?.path).toBeNull();
});

describe("parseBranchMap tolerant reader", () => {
  test("parses 3-level (kind-keyed) map with canonical kinds", () => {
    const result = parseBranchMap({
      "local-docker": {
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "local-docker",
      },
      "user-desktop": {
        sandboxHandle: "v2",
        previewUrl: null,
        sandboxProviderKind: "user-desktop",
      },
    });
    expect(result["local-docker"]?.sandboxHandle).toBe("v1");
    expect(result["user-desktop"]?.sandboxHandle).toBe("v2");
  });

  test("normalizes legacy kind keys to canonical ones", () => {
    const result = parseBranchMap({
      docker: {
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "docker",
      },
      desktop: {
        sandboxHandle: "v2",
        previewUrl: null,
        sandboxProviderKind: "desktop",
      },
    });
    expect(result["local-docker"]?.sandboxHandle).toBe("v1");
    expect(result["user-desktop"]?.sandboxHandle).toBe("v2");
  });

  test("wraps 2-level legacy entry under its sandboxProviderKind", () => {
    const result = parseBranchMap({
      sandboxHandle: "v-legacy",
      previewUrl: null,
      sandboxProviderKind: "desktop",
    });
    expect(result["user-desktop"]?.sandboxHandle).toBe("v-legacy");
    expect(result["local-docker"]).toBeUndefined();
  });

  test("coalesces a legacy freestyle entry to local-docker on read", () => {
    const result = parseBranchMap({
      sandboxHandle: "v-very-legacy",
      previewUrl: null,
      runnerKind: "freestyle",
    });
    // freestyle runner no longer exists; legacy rows fall back to local-docker.
    expect(result["local-docker"]?.sandboxHandle).toBe("v-very-legacy");
  });

  test("returns empty object for null/undefined/arrays", () => {
    expect(parseBranchMap(null)).toEqual({});
    expect(parseBranchMap(undefined)).toEqual({});
    expect(parseBranchMap([])).toEqual({});
  });

  test("legacy entry without sandboxProviderKind defaults to 'local-docker'", () => {
    const result = parseBranchMap({
      sandboxHandle: "v-orphan",
      previewUrl: null,
    });
    expect(result["local-docker"]?.sandboxHandle).toBe("v-orphan");
  });

  test("tolerates legacy `vmId` field on read (pre-rename rows)", () => {
    // Migration 091 will rewrite stored `vmId` keys to `sandboxHandle`; until
    // it runs, both 2-level and 3-level shapes must still parse.
    const twoLevel = parseBranchMap({
      vmId: "v-pre-rename",
      previewUrl: null,
      sandboxProviderKind: "local-docker",
    });
    expect(twoLevel["local-docker"]?.sandboxHandle).toBe("v-pre-rename");

    const threeLevel = parseBranchMap({
      "local-docker": {
        vmId: "v-pre-rename-2",
        previewUrl: null,
        sandboxProviderKind: "local-docker",
      },
    });
    expect(threeLevel["local-docker"]?.sandboxHandle).toBe("v-pre-rename-2");
  });
});

describe("parseVmMapEntry tolerant reader", () => {
  test("accepts canonical sandboxProviderKind", () => {
    const result = parseVmMapEntry({
      sandboxHandle: "v1",
      previewUrl: null,
      sandboxProviderKind: "local-docker",
    });
    expect(result.sandboxProviderKind).toBe("local-docker");
  });

  test("normalizes legacy kind name to canonical", () => {
    const result = parseVmMapEntry({
      sandboxHandle: "v1",
      previewUrl: null,
      sandboxProviderKind: "docker",
    });
    expect(result.sandboxProviderKind).toBe("local-docker");
  });

  test("normalizes legacy runnerKind into sandboxProviderKind", () => {
    const result = parseVmMapEntry({
      sandboxHandle: "v1",
      previewUrl: null,
      runnerKind: "desktop",
    });
    expect(result.sandboxProviderKind).toBe("user-desktop");
    expect(
      (result as unknown as { runnerKind?: unknown }).runnerKind,
    ).toBeUndefined();
  });

  test("prefers explicit sandboxProviderKind when both keys present", () => {
    const result = parseVmMapEntry({
      sandboxHandle: "v1",
      previewUrl: null,
      runnerKind: "docker",
      sandboxProviderKind: "desktop",
    });
    expect(result.sandboxProviderKind).toBe("user-desktop");
  });

  test("normalizes legacy `vmId` field into `sandboxHandle`", () => {
    // Pre-rename rows persisted the handle field as `vmId`; the tolerant
    // reader maps it to the canonical `sandboxHandle` while migration 091
    // is still in flight.
    const result = parseVmMapEntry({
      vmId: "v-pre-rename",
      previewUrl: null,
      sandboxProviderKind: "local-docker",
    });
    expect(result.sandboxHandle).toBe("v-pre-rename");
    expect((result as unknown as { vmId?: unknown }).vmId).toBeUndefined();
  });

  test("prefers canonical `sandboxHandle` over legacy `vmId` when both present", () => {
    const result = parseVmMapEntry({
      vmId: "v-legacy",
      sandboxHandle: "v-canonical",
      previewUrl: null,
      sandboxProviderKind: "local-docker",
    });
    expect(result.sandboxHandle).toBe("v-canonical");
  });
});
