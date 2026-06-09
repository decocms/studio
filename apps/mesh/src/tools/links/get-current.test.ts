import { describe, it, expect } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { createInMemoryLinkClaimRegistry } from "../../links/link-claim-registry";
import type { LinkClaim } from "../../links/link-claim-registry";
import { LINK_CURRENT_GET } from "./get-current";

const STUB_CLAIM: LinkClaim = {
  podId: "pod_1",
  machineId: "machine_abc",
  cliVersion: "1.2.3",
  previewPort: 5174,
  connectedAt: Date.now(),
  capabilities: ["claude-code"],
};

const USER_ID = "user_1";

function makeCtx(
  overrides: Partial<
    Pick<StudioContext, "linkClaimRegistry" | "auth" | "access">
  > = {},
): StudioContext {
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
  } as unknown as StudioContext;
}

describe("LINK_CURRENT_GET", () => {
  it("returns offline when no registry is wired", async () => {
    const ctx = makeCtx({ linkClaimRegistry: undefined });
    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("returns offline when registry has no entry for the user", async () => {
    const registry = createInMemoryLinkClaimRegistry();
    const ctx = makeCtx({ linkClaimRegistry: registry });
    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("returns online with claim fields when link is active", async () => {
    const registry = createInMemoryLinkClaimRegistry();
    await registry.put(USER_ID, STUB_CLAIM);
    const ctx = makeCtx({ linkClaimRegistry: registry });

    const result = await LINK_CURRENT_GET.handler({}, ctx);

    expect(result.online).toBe(true);
    expect(result.machineId).toBe("machine_abc");
    expect(result.cliVersion).toBe("1.2.3");
    expect(result.capabilities).toEqual(["claude-code"]);
  });

  it("returns offline after the claim is deleted", async () => {
    const registry = createInMemoryLinkClaimRegistry();
    await registry.put(USER_ID, STUB_CLAIM);
    await registry.delete(USER_ID);
    const ctx = makeCtx({ linkClaimRegistry: registry });

    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("never exposes sensitive fields in the response", async () => {
    const registry = createInMemoryLinkClaimRegistry();
    await registry.put(USER_ID, STUB_CLAIM);
    const ctx = makeCtx({ linkClaimRegistry: registry });

    const result = await LINK_CURRENT_GET.handler({}, ctx);
    const json = JSON.stringify(result);
    expect(json).not.toContain("podId");
    expect(json).not.toContain("previewPort");
    expect(json).not.toContain("connectedAt");
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
