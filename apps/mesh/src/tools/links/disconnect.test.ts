import { describe, it, expect } from "bun:test";
import type { ControlFrame } from "../../api/routes/decopilot/control-frames";
import type { StudioContext } from "../../core/studio-context";
import { createInMemoryLinkClaimRegistry } from "../../links/link-claim-registry";
import type { LinkClaim } from "../../links/link-claim-registry";
import { LINK_DISCONNECT } from "./disconnect";

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
    Pick<
      StudioContext,
      "linkClaimRegistry" | "publishLinkControlFrame" | "auth" | "access"
    >
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

describe("LINK_DISCONNECT", () => {
  it("returns disconnected: false when no registry is wired", async () => {
    const ctx = makeCtx({ linkClaimRegistry: undefined });
    const result = await LINK_DISCONNECT.handler({}, ctx);
    expect(result).toEqual({ disconnected: false });
  });

  it("returns disconnected: false and publishes nothing when no link is registered", async () => {
    const published: ControlFrame[] = [];
    const registry = createInMemoryLinkClaimRegistry();
    const ctx = makeCtx({
      linkClaimRegistry: registry,
      publishLinkControlFrame: (_userSub, frame) => published.push(frame),
    });

    const result = await LINK_DISCONNECT.handler({}, ctx);

    expect(result).toEqual({ disconnected: false });
    expect(published).toEqual([]);
  });

  it("publishes a shutdown frame to the caller's channel and deletes the claim", async () => {
    const published: Array<{ userSub: string; frame: ControlFrame }> = [];
    const registry = createInMemoryLinkClaimRegistry();
    await registry.put(USER_ID, STUB_CLAIM);
    const ctx = makeCtx({
      linkClaimRegistry: registry,
      publishLinkControlFrame: (userSub, frame) =>
        published.push({ userSub, frame }),
    });

    const result = await LINK_DISCONNECT.handler({}, ctx);

    expect(result).toEqual({ disconnected: true });
    expect(published).toEqual([
      { userSub: USER_ID, frame: { type: "shutdown" } },
    ]);
    expect(await registry.get(USER_ID)).toBeNull();
  });

  it("still deletes the claim when no frame publisher is wired (test/no-NATS contexts)", async () => {
    const registry = createInMemoryLinkClaimRegistry();
    await registry.put(USER_ID, STUB_CLAIM);
    const ctx = makeCtx({
      linkClaimRegistry: registry,
      publishLinkControlFrame: undefined,
    });

    const result = await LINK_DISCONNECT.handler({}, ctx);

    expect(result).toEqual({ disconnected: true });
    expect(await registry.get(USER_ID)).toBeNull();
  });

  it("throws when called without auth", async () => {
    const ctx = makeCtx({ auth: {} });
    await expect(LINK_DISCONNECT.handler({}, ctx)).rejects.toThrow(
      "Authentication required",
    );
  });
});
