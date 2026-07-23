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
});
