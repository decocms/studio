import { describe, expect, it, test } from "bun:test";
import {
  SandboxMapSchema,
  VirtualMCPEntitySchema,
  VirtualMCPCreateDataSchema,
  VirtualMcpUILayoutSchema,
  VirtualMCPUpdateDataSchema,
  SandboxRecordSchema,
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

test("SandboxRecord rejects rows missing sandboxHandle", () => {
  expect(
    SandboxRecordSchema.safeParse({ vmId: "v-pre-rename", previewUrl: null })
      .success,
  ).toBe(false);
});

describe("parseBranchMap", () => {
  test("parses 3-level (kind-keyed) map with canonical kinds", () => {
    const result = parseBranchMap({
      "agent-sandbox": {
        sandboxHandle: "v1",
        previewUrl: null,
      },
      "local-api": {
        sandboxHandle: "v2",
        previewUrl: null,
      },
    });
    expect(result["agent-sandbox"]?.sandboxHandle).toBe("v1");
    expect(result["local-api"]?.sandboxHandle).toBe("v2");
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
      },
      "local-docker": {
        sandboxHandle: "v-retired",
        previewUrl: null,
      },
    });
    expect(result).toEqual({});
  });
});

const canonicalSandboxRecord = {
  sandboxHandle: "v1",
  previewUrl: null,
} as const;

function expectSandboxMapHasOnlyCanonicalProviderKind(
  sandboxMap: Record<string, Record<string, Record<string, unknown>>>,
) {
  expect(sandboxMap.u?.b?.["agent-sandbox"]).toEqual(canonicalSandboxRecord);
}

describe("Sandbox map provider kind validation", () => {
  test("normalizeSandboxMap keeps canonical provider keys", () => {
    const parsed = normalizeSandboxMap({
      u: {
        b: {
          "agent-sandbox": canonicalSandboxRecord,
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

  test("create and update reject the server-managed sandbox map", () => {
    const sandboxMap = {
      u: { b: { "agent-sandbox": canonicalSandboxRecord } },
    };

    expect(
      VirtualMCPCreateDataSchema.safeParse({
        title: "x",
        metadata: { sandboxMap },
        connections: [],
      }).success,
    ).toBe(false);
    expect(
      VirtualMCPUpdateDataSchema.safeParse({ metadata: { sandboxMap } })
        .success,
    ).toBe(false);
  });

  test("rejects unsupported provider keys at write boundaries", () => {
    const sandboxMap = {
      u: {
        b: {
          "unsupported-provider": {
            sandboxHandle: "unsupported",
            previewUrl: null,
          },
        },
      },
    };

    expect(SandboxMapSchema.safeParse(sandboxMap).success).toBe(false);
    expect(
      VirtualMCPCreateDataSchema.safeParse({
        title: "x",
        metadata: { sandboxMap },
        connections: [],
      }).success,
    ).toBe(false);
    expect(
      VirtualMCPUpdateDataSchema.safeParse({ metadata: { sandboxMap } })
        .success,
    ).toBe(false);
  });
});
