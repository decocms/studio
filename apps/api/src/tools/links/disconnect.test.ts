import { describe, it, expect } from "bun:test";
import type { ControlFrame } from "../../api/routes/decopilot/control-frames";
import type { StudioContext } from "../../core/studio-context";
import { LINK_DISCONNECT } from "./disconnect";

const USER_ID = "user_1";

function makeCtx(
  overrides: Partial<
    Pick<StudioContext, "publishLinkControlFrame" | "auth" | "access">
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
    baseUrl: "https://studio.example.com",
    metadata: { requestId: "req_1", timestamp: new Date() },
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
  it("returns disconnected: false when no frame publisher is wired", async () => {
    const ctx = makeCtx({ publishLinkControlFrame: undefined });
    const result = await LINK_DISCONNECT.handler({}, ctx);
    expect(result).toEqual({ disconnected: false });
  });

  it("publishes a shutdown frame to the caller's channel and returns disconnected: true", async () => {
    const published: Array<{ userSub: string; frame: ControlFrame }> = [];
    const ctx = makeCtx({
      publishLinkControlFrame: (userSub, frame) =>
        published.push({ userSub, frame }),
    });

    const result = await LINK_DISCONNECT.handler({}, ctx);

    expect(result).toEqual({ disconnected: true });
    expect(published).toEqual([
      { userSub: USER_ID, frame: { type: "shutdown" } },
    ]);
  });

  it("throws when called without auth", async () => {
    const ctx = makeCtx({ auth: {} });
    await expect(LINK_DISCONNECT.handler({}, ctx)).rejects.toThrow(
      "Authentication required",
    );
  });
});
