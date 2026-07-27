import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_SETTINGS_UPDATE } from "./settings-update";

function makeCtx(organization: { id: string } | undefined) {
  return {
    auth: { user: { id: "user-1" } },
    organization,
    access: { check: mock(async () => {}) },
    storage: {
      organizationSettings: {
        upsert: mock(async (organizationId: string) => ({
          organizationId,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        })),
      },
    },
  } as unknown as Parameters<typeof ORGANIZATION_SETTINGS_UPDATE.handler>[1];
}

describe("ORGANIZATION_SETTINGS_UPDATE", () => {
  it("rejects a write scoped to a different organization than the context", async () => {
    const ctx = makeCtx({ id: "org-a" });

    await expect(
      ORGANIZATION_SETTINGS_UPDATE.handler({ organizationId: "org-b" }, ctx),
    ).rejects.toThrow(/different organization/i);
  });

  it("fails closed instead of writing an unscoped organizationId when ctx.organization is unresolved", async () => {
    // Regression: `if (ctx.organization && ctx.organization.id !== input.organizationId)`
    // skipped the mismatch check entirely when ctx.organization was undefined,
    // letting the client-supplied organizationId through unvalidated.
    const ctx = makeCtx(undefined);

    await expect(
      ORGANIZATION_SETTINGS_UPDATE.handler({ organizationId: "org-b" }, ctx),
    ).rejects.toThrow(/organization scope/i);

    expect(
      (
        ctx as unknown as {
          storage: {
            organizationSettings: { upsert: ReturnType<typeof mock> };
          };
        }
      ).storage.organizationSettings.upsert,
    ).not.toHaveBeenCalled();
  });

  it("allows a write matching the context's organization", async () => {
    const ctx = makeCtx({ id: "org-a" });

    const result = await ORGANIZATION_SETTINGS_UPDATE.handler(
      { organizationId: "org-a" },
      ctx,
    );

    expect(result.organizationId).toBe("org-a");
  });

  it("forwards main_agent_id to storage — a set id and an explicit null to clear", async () => {
    const upsert = (ctx: ReturnType<typeof makeCtx>): ReturnType<typeof mock> =>
      (
        ctx as unknown as {
          storage: {
            organizationSettings: { upsert: ReturnType<typeof mock> };
          };
        }
      ).storage.organizationSettings.upsert;

    const setCtx = makeCtx({ id: "org-a" });
    await ORGANIZATION_SETTINGS_UPDATE.handler(
      { organizationId: "org-a", main_agent_id: "vmcp-1" },
      setCtx,
    );
    expect(upsert(setCtx).mock.calls[0]?.[1]).toMatchObject({
      main_agent_id: "vmcp-1",
    });

    // Explicit null must be forwarded (not dropped) so the storage layer can
    // clear the column and fall the org landing back to the Super Agent.
    const clearCtx = makeCtx({ id: "org-a" });
    await ORGANIZATION_SETTINGS_UPDATE.handler(
      { organizationId: "org-a", main_agent_id: null },
      clearCtx,
    );
    expect(upsert(clearCtx).mock.calls[0]?.[1]).toMatchObject({
      main_agent_id: null,
    });
  });

  it("forwards flags to storage — true and explicit false both persist", async () => {
    const upsert = (ctx: ReturnType<typeof makeCtx>): ReturnType<typeof mock> =>
      (
        ctx as unknown as {
          storage: {
            organizationSettings: { upsert: ReturnType<typeof mock> };
          };
        }
      ).storage.organizationSettings.upsert;

    const onCtx = makeCtx({ id: "org-a" });
    await ORGANIZATION_SETTINGS_UPDATE.handler(
      { organizationId: "org-a", flags: { demo_mode: true } },
      onCtx,
    );
    expect(upsert(onCtx).mock.calls[0]?.[1]).toMatchObject({
      flags: { demo_mode: true },
    });

    // Explicit false must be forwarded (not dropped) so the storage merge can
    // switch a demo org back to the normal connect gate.
    const offCtx = makeCtx({ id: "org-a" });
    await ORGANIZATION_SETTINGS_UPDATE.handler(
      { organizationId: "org-a", flags: { demo_mode: false } },
      offCtx,
    );
    expect(upsert(offCtx).mock.calls[0]?.[1]).toMatchObject({
      flags: { demo_mode: false },
    });
  });

  it("rejects an unrecognized flag key instead of silently stripping it", () => {
    // Regression: without `.strict()`, Zod drops unknown keys from an object
    // schema — a mistyped flag name (e.g. `demoMode` instead of `demo_mode`)
    // would previously validate as `flags: {}`, upsert as a no-op, and report
    // success with no indication the intended flag was never set.
    const result = ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
      organizationId: "org-a",
      flags: { demoMode: true },
    });

    expect(result.success).toBe(false);
  });
});
