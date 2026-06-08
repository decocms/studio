import { describe, expect, it, test } from "bun:test";
import {
  SandboxMapSchema,
  VirtualMCPEntitySchema,
  VirtualMCPCreateDataSchema,
  VirtualMcpUILayoutSchema,
  VirtualMCPUpdateDataSchema,
  SandboxRecordSchema,
  parseSandboxRecord,
  parseBranchMap,
  normalizeSandboxMap,
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

describe("parseBranchMap", () => {
  test("parses 3-level (kind-keyed) map with canonical kinds", () => {
    const result = parseBranchMap({
      "agent-sandbox": {
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "agent-sandbox",
      },
      "user-desktop": {
        sandboxHandle: "v2",
        previewUrl: null,
        sandboxProviderKind: "user-desktop",
      },
    });
    expect(result["agent-sandbox"]?.sandboxHandle).toBe("v1");
    expect(result["user-desktop"]?.sandboxHandle).toBe("v2");
  });

  test("normalizes legacy cluster key and record kind", () => {
    const result = parseBranchMap({
      cluster: {
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "cluster",
      },
    });
    expect(result).toEqual({
      "agent-sandbox": {
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "agent-sandbox",
      },
    });
  });

  test("prefers canonical agent-sandbox over legacy cluster regardless of key order", () => {
    const canonical = {
      sandboxHandle: "canonical",
      previewUrl: null,
      sandboxProviderKind: "agent-sandbox",
    };
    const legacy = {
      sandboxHandle: "legacy",
      previewUrl: null,
      sandboxProviderKind: "cluster",
    };

    expect(
      parseBranchMap({
        "agent-sandbox": canonical,
        cluster: legacy,
      })["agent-sandbox"]?.sandboxHandle,
    ).toBe("canonical");
    expect(
      parseBranchMap({
        cluster: legacy,
        "agent-sandbox": canonical,
      })["agent-sandbox"]?.sandboxHandle,
    ).toBe("canonical");
  });

  test("returns empty object for null/undefined/arrays", () => {
    expect(parseBranchMap(null)).toEqual({});
    expect(parseBranchMap(undefined)).toEqual({});
    expect(parseBranchMap([])).toEqual({});
  });

  test("skips entries under legacy/retired kind keys", () => {
    // Migrations 092/097 rewrote/dropped every legacy and retired key; reader
    // no longer normalizes unknown keys, it just ignores them.
    const result = parseBranchMap({
      docker: {
        sandboxHandle: "v-legacy",
        previewUrl: null,
        sandboxProviderKind: "cluster",
      },
      "local-docker": {
        sandboxHandle: "v-retired",
        previewUrl: null,
        sandboxProviderKind: "cluster",
      },
    });
    expect(result).toEqual({});
  });
});

describe("parseSandboxRecord", () => {
  test("accepts canonical sandboxProviderKind", () => {
    const result = parseSandboxRecord({
      sandboxHandle: "v1",
      previewUrl: null,
      sandboxProviderKind: "agent-sandbox",
    });
    expect(result.sandboxProviderKind).toBe("agent-sandbox");
  });

  test("normalizes legacy cluster sandboxProviderKind", () => {
    const result = parseSandboxRecord({
      sandboxHandle: "v1",
      previewUrl: null,
      sandboxProviderKind: "cluster",
    });
    expect(result.sandboxProviderKind).toBe("agent-sandbox");
  });

  test("rejects legacy/retired kind values", () => {
    expect(() =>
      parseSandboxRecord({
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "docker",
      }),
    ).toThrow();
    expect(() =>
      parseSandboxRecord({
        sandboxHandle: "v1",
        previewUrl: null,
        sandboxProviderKind: "local-docker",
      }),
    ).toThrow();
  });

  test("rejects rows missing `sandboxHandle` (legacy `vmId` no longer accepted)", () => {
    expect(() =>
      parseSandboxRecord({
        vmId: "v-pre-rename",
        previewUrl: null,
        sandboxProviderKind: "agent-sandbox",
      }),
    ).toThrow();
  });
});

const sandboxRecord = {
  sandboxHandle: "v1",
  previewUrl: null,
  sandboxProviderKind: "cluster",
} as const;

const canonicalSandboxRecord = {
  sandboxHandle: "v1",
  previewUrl: null,
  sandboxProviderKind: "agent-sandbox",
} as const;

function expectSandboxMapHasOnlyCanonicalProviderKind(
  sandboxMap: Record<string, Record<string, Record<string, unknown>>>,
) {
  expect(sandboxMap.u?.b?.cluster).toBeUndefined();
  expect(sandboxMap.u?.b?.["agent-sandbox"]).toEqual(canonicalSandboxRecord);
}

describe("Sandbox map provider kind normalization", () => {
  test("normalizeSandboxMap normalizes legacy cluster keys and record kinds", () => {
    const parsed = normalizeSandboxMap({
      u: {
        b: {
          cluster: sandboxRecord,
        },
      },
    });

    expectSandboxMapHasOnlyCanonicalProviderKind(parsed);
  });

  test("SandboxMapSchema accepts canonical provider maps", () => {
    const parsed = SandboxMapSchema.parse({
      u: {
        b: {
          "agent-sandbox": canonicalSandboxRecord,
        },
      },
    });

    expectSandboxMapHasOnlyCanonicalProviderKind(parsed);
  });

  test("VirtualMCPEntitySchema accepts canonical embedded sandbox maps", () => {
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
        sandboxMap: { u: { b: { "agent-sandbox": canonicalSandboxRecord } } },
      },
      connections: [],
    });

    expectSandboxMapHasOnlyCanonicalProviderKind(parsed.metadata.sandboxMap!);
  });

  test("VirtualMCPCreateDataSchema accepts canonical embedded sandbox maps", () => {
    const parsed = VirtualMCPCreateDataSchema.parse({
      title: "x",
      metadata: {
        sandboxMap: { u: { b: { "agent-sandbox": canonicalSandboxRecord } } },
      },
      connections: [],
    });

    expectSandboxMapHasOnlyCanonicalProviderKind(parsed.metadata!.sandboxMap!);
  });

  test("VirtualMCPUpdateDataSchema accepts canonical embedded sandbox maps", () => {
    const parsed = VirtualMCPUpdateDataSchema.parse({
      metadata: {
        sandboxMap: { u: { b: { "agent-sandbox": canonicalSandboxRecord } } },
      },
    });

    expectSandboxMapHasOnlyCanonicalProviderKind(parsed.metadata!.sandboxMap!);
  });
});
