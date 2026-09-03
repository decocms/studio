import { describe, expect, it, test } from "bun:test";
import {
  AgentKickstartPromptSchema,
  SandboxMapSchema,
  VirtualMCPEntitySchema,
  VirtualMCPCreateDataSchema,
  VirtualMcpUILayoutSchema,
  VirtualMCPUpdateDataSchema,
  SandboxRecordSchema,
  parseBranchMap,
  normalizeSandboxMap,
  normalizeCmsMode,
  resolveCmsMode,
  withCmsMode,
} from "./virtual-mcp";

describe("AgentKickstartPromptSchema", () => {
  it("rejects a text longer than 4000 chars", () => {
    const result = AgentKickstartPromptSchema.safeParse({
      title: "Say hi",
      text: "a".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a text at the 4000 char boundary", () => {
    const result = AgentKickstartPromptSchema.safeParse({
      title: "Say hi",
      text: "a".repeat(4000),
    });
    expect(result.success).toBe(true);
  });
});

describe("withCmsMode", () => {
  it("writes the mode and drops the boolean it supersedes", () => {
    expect(withCmsMode({ cmsDefaultOpen: true }, "on")).toEqual({
      cms: "on",
      cmsDefaultOpen: null,
    });
    expect(resolveCmsMode(withCmsMode({ cmsDefaultOpen: true }, "on"))).toBe(
      "on",
    );
  });

  it("keeps every other layout setting", () => {
    const layout = {
      chatDefaultOpen: true,
      defaultMainView: { type: "site-editor" },
      tabs: [
        {
          id: "analytics",
          title: "Analytics",
          view: { type: "ext-app" as const, appId: "app_abc" },
        },
      ],
    };
    const next = withCmsMode(layout, "on");
    expect(next.chatDefaultOpen).toBe(true);
    expect(next.defaultMainView).toEqual({ type: "site-editor" });
    expect(next.tabs).toEqual(layout.tabs);
  });

  it("moves an agent off a Content home when the CMS goes off", () => {
    const next = withCmsMode({ defaultMainView: { type: "content" } }, "off");
    expect(next.defaultMainView).toEqual({ type: "site-editor" });
  });

  it("leaves a Content home alone while the CMS is still offered", () => {
    expect(
      withCmsMode({ defaultMainView: { type: "content" } }, "on")
        .defaultMainView,
    ).toEqual({ type: "content" });
  });

  it("leaves any other home alone when the CMS goes off", () => {
    expect(
      withCmsMode({ defaultMainView: { type: "chat" } }, "off").defaultMainView,
    ).toEqual({ type: "chat" });
    expect(withCmsMode(null, "off").defaultMainView).toBeUndefined();
  });

  it("produces a layout the schema accepts", () => {
    expect(() =>
      VirtualMcpUILayoutSchema.parse(
        withCmsMode({ defaultMainView: { type: "content" } }, "off"),
      ),
    ).not.toThrow();
  });
});

describe("normalizeCmsMode", () => {
  /** THE migration this collapse turns on: `auto` and `manual` are persisted
   *  on real agents, and reading either as anything but `on` would take a
   *  configured CMS away from every one of them. */
  it("reads the retired modes as on", () => {
    expect(normalizeCmsMode("auto")).toBe("on");
    expect(normalizeCmsMode("manual")).toBe("on");
  });

  it("passes the live modes through", () => {
    expect(normalizeCmsMode("on")).toBe("on");
    expect(normalizeCmsMode("off")).toBe("off");
  });

  it("has no answer for an absent or unknown value", () => {
    expect(normalizeCmsMode(null)).toBeNull();
    expect(normalizeCmsMode(undefined)).toBeNull();
    expect(normalizeCmsMode("")).toBeNull();
    expect(normalizeCmsMode("hidden")).toBeNull();
  });
});

describe("resolveCmsMode", () => {
  it("defaults to on for an agent that never configured a CMS", () => {
    expect(resolveCmsMode(null)).toBe("on");
    expect(resolveCmsMode(undefined)).toBe("on");
    expect(resolveCmsMode({})).toBe("on");
  });

  it("reads a stored auto / manual as on", () => {
    expect(resolveCmsMode({ cms: "auto" })).toBe("on");
    expect(resolveCmsMode({ cms: "manual" })).toBe("on");
  });

  it("keeps off, the only mode anyone opts into", () => {
    expect(resolveCmsMode({ cms: "off" })).toBe("off");
  });

  it("round-trips every mode through the layout schema", () => {
    for (const cms of ["off", "on"] as const) {
      expect(resolveCmsMode(VirtualMcpUILayoutSchema.parse({ cms }))).toBe(cms);
    }
  });

  it("still parses a layout carrying a retired mode", () => {
    for (const cms of ["manual", "auto"] as const) {
      expect(resolveCmsMode(VirtualMcpUILayoutSchema.parse({ cms }))).toBe(
        "on",
      );
    }
  });

  it("rejects a mode outside the enum", () => {
    expect(() => VirtualMcpUILayoutSchema.parse({ cms: "hidden" })).toThrow();
  });
});

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
