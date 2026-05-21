import { describe, it, expect } from "bun:test";
import type { MeshContext } from "../../core/mesh-context";
import { createInMemoryLinkRegistry } from "../../links/link-registry";
import type { LinkEntry } from "@/links/protocol";
import { LINK_CURRENT_GET } from "./get-current";

const STUB_ENTRY: LinkEntry = {
  machineId: "machine_abc",
  tunnelUrl: "https://link-user_1.deco.host",
  linkSecret: "super-secret-do-not-leak",
  cliVersion: "1.2.3",
  protocolVersion: 1,
  capabilities: ["claude-code"],
  createdAt: new Date().toISOString(),
};

const USER_ID = "user_1";

function makeCtx(
  overrides: Partial<
    Pick<MeshContext, "linkRegistry" | "auth" | "access">
  > = {},
): MeshContext {
  return {
    auth: {
      user: {
        id: USER_ID,
        email: "test@example.com",
        name: "Test",
        role: "user",
      },
    },
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
    },
    organization: { id: "org_1", slug: "test-org", name: "Test Org" },
    storage: {} as never,
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    vault: null as never,
    db: null as never,
    authInstance: null as never,
    boundAuth: null as never,
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
    metadata: { requestId: "req_1", timestamp: new Date() },
    eventBus: null as never,
    objectStorage: null as never,
    aiProviders: null as never,
    createMCPProxy: null as never,
    getOrCreateClient: null as never,
    pendingRevalidations: [],
    monitoring: null as never,
    ...overrides,
  } as unknown as MeshContext;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("LINK_CURRENT_GET", () => {
  it("returns offline when no registry is wired", async () => {
    const ctx = makeCtx({ linkRegistry: undefined });
    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("returns offline when registry has no entry for the user", async () => {
    const registry = createInMemoryLinkRegistry({ nowSeconds });
    const ctx = makeCtx({ linkRegistry: registry });
    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("returns online with entry fields when link is active", async () => {
    const registry = createInMemoryLinkRegistry({ nowSeconds });
    await registry.put(USER_ID, STUB_ENTRY);
    const ctx = makeCtx({ linkRegistry: registry });

    const result = await LINK_CURRENT_GET.handler({}, ctx);

    expect(result.online).toBe(true);
    expect(result.machineId).toBe("machine_abc");
    expect(result.cliVersion).toBe("1.2.3");
    expect(result.capabilities).toEqual(["claude-code"]);
  });

  it("returns offline when the TTL has expired", async () => {
    const registry = createInMemoryLinkRegistry({
      ttlSeconds: 10,
      nowSeconds,
    });
    await registry.put(USER_ID, STUB_ENTRY);
    // Advance clock past TTL
    registry.advanceNow(11);
    const ctx = makeCtx({ linkRegistry: registry });

    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("never exposes linkSecret in the response", async () => {
    const registry = createInMemoryLinkRegistry({ nowSeconds });
    await registry.put(USER_ID, STUB_ENTRY);
    const ctx = makeCtx({ linkRegistry: registry });

    const result = await LINK_CURRENT_GET.handler({}, ctx);
    const json = JSON.stringify(result);
    expect(json).not.toContain("linkSecret");
    expect(json).not.toContain("super-secret-do-not-leak");
  });

  it("throws when called without auth", async () => {
    const ctx = makeCtx({
      auth: {},
    });
    await expect(LINK_CURRENT_GET.handler({}, ctx)).rejects.toThrow(
      "Authentication required",
    );
  });
});
