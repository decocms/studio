import { describe, it, expect, vi } from "bun:test";
import {
  ORGANIZATION_SETTINGS_GET,
  ORGANIZATION_SETTINGS_UPDATE,
} from "./index";
import type {
  BetterAuthInstance,
  BoundAuthClient,
  MeshContext,
} from "../../core/mesh-context";
import type { OrganizationSettings } from "../../storage/types";

const SAMPLE_SIMPLE_MODE = {
  enabled: true,
  chat: {
    fast: { keyId: "key_1", modelId: "gpt-4o-mini", title: "Fast" },
    smart: { keyId: "key_1", modelId: "gpt-4o", title: "Smart" },
    thinking: { keyId: "key_1", modelId: "o1-preview", title: "Thinking" },
  },
  image: { keyId: "key_2", modelId: "dall-e-3", title: "Image" },
  webResearch: null,
};

const SAMPLE_REGISTRY_CONFIG = {
  registries: { conn_x: { enabled: true } },
  blockedMcps: ["spam-mcp"],
};

const buildStoredSettings = (
  overrides: Partial<OrganizationSettings> = {},
): OrganizationSettings => ({
  organizationId: "org_123",
  sidebar_items: null,
  enabled_plugins: null,
  registry_config: null,
  simple_mode: null,
  default_home_agents: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

const createMockContext = (
  storedSettings: OrganizationSettings | null,
): MeshContext => {
  const get = vi.fn().mockResolvedValue(storedSettings);
  const upsert = vi.fn(async (_orgId: string, data) => ({
    ...buildStoredSettings(storedSettings ?? undefined),
    ...data,
  }));

  return {
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    eventBus: vi.fn().mockResolvedValue(undefined) as never,
    auth: {
      user: {
        id: "user_1",
        email: "[email protected]",
        name: "Test",
        role: "admin",
      },
    },
    organization: {
      id: "org_123",
      slug: "test-org",
      name: "Test Organization",
    },
    storage: {
      connections: null as never,
      organizationSettings: { get, upsert } as never,
      monitoring: null as never,
      virtualMcps: null as never,
      users: null as never,
      threads: null as never,
      tags: null as never,
      virtualMcpPluginConfigs: null as never,
      aiProviderKeys: null as never,
      oauthPkceStates: null as never,
      automations: null as never,
      orgSsoConfig: null as never,
      orgSsoSessions: null as never,
      triggerCallbackTokens: null as never,
      registry: null as never,
      brandContext: null as never,
      organizationDomains: null as never,
    },
    vault: null as never,
    authInstance: {} as unknown as BetterAuthInstance,
    boundAuth: {} as unknown as BoundAuthClient,
    access: {
      granted: () => true,
      check: vi.fn().mockResolvedValue(undefined),
      grant: () => {},
      setToolName: () => {},
    } as never,
    db: null as never,
    tracer: {
      startActiveSpan: (
        _name: string,
        _opts: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        }),
    } as never,
    meter: {
      createHistogram: () => ({ record: () => {} }),
      createCounter: () => ({ add: () => {} }),
    } as never,
    baseUrl: "https://mesh.example.com",
    metadata: { requestId: "req_123", timestamp: new Date() },
    objectStorage: null as never,
    aiProviders: null as never,
    createMCPProxy: vi.fn().mockResolvedValue({}),
    getOrCreateClient: vi.fn().mockResolvedValue({}),
    pendingRevalidations: [],
  };
};

describe("ORGANIZATION_SETTINGS_GET", () => {
  it("returns simple_mode from stored settings", async () => {
    const ctx = createMockContext(
      buildStoredSettings({ simple_mode: SAMPLE_SIMPLE_MODE }),
    );

    const result = await ORGANIZATION_SETTINGS_GET.execute({}, ctx);

    expect(result.simple_mode).toEqual(SAMPLE_SIMPLE_MODE);
  });
});

describe("ORGANIZATION_SETTINGS_UPDATE", () => {
  it("forwards simple_mode to the storage upsert", async () => {
    const ctx = createMockContext(buildStoredSettings());

    await ORGANIZATION_SETTINGS_UPDATE.execute(
      {
        organizationId: "org_123",
        simple_mode: SAMPLE_SIMPLE_MODE,
      },
      ctx,
    );

    expect(ctx.storage.organizationSettings.upsert).toHaveBeenCalledWith(
      "org_123",
      expect.objectContaining({ simple_mode: SAMPLE_SIMPLE_MODE }),
    );
  });

  it("does not clobber unrelated fields when only simple_mode is passed", async () => {
    const ctx = createMockContext(buildStoredSettings());

    await ORGANIZATION_SETTINGS_UPDATE.execute(
      {
        organizationId: "org_123",
        simple_mode: SAMPLE_SIMPLE_MODE,
      },
      ctx,
    );

    const calls = (
      ctx.storage.organizationSettings.upsert as unknown as {
        mock: { calls: [string, Record<string, unknown>][] };
      }
    ).mock.calls;
    const upsertData = calls[0]?.[1] ?? {};
    expect(upsertData.sidebar_items).toBeUndefined();
    expect(upsertData.enabled_plugins).toBeUndefined();
    expect(upsertData.registry_config).toBeUndefined();
  });

  it("forwards registry_config without touching simple_mode", async () => {
    const ctx = createMockContext(buildStoredSettings());

    await ORGANIZATION_SETTINGS_UPDATE.execute(
      {
        organizationId: "org_123",
        registry_config: SAMPLE_REGISTRY_CONFIG,
      },
      ctx,
    );

    const calls = (
      ctx.storage.organizationSettings.upsert as unknown as {
        mock: { calls: [string, Record<string, unknown>][] };
      }
    ).mock.calls;
    const upsertData = calls[0]?.[1] ?? {};
    expect(upsertData.registry_config).toEqual(SAMPLE_REGISTRY_CONFIG);
    expect(upsertData.simple_mode).toBeUndefined();
  });
});
