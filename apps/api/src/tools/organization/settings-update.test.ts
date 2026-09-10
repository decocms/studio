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

  it("rejects oversized sidebar_items, blockedMcps, default_home_agents.ids, and enabled_plugins", () => {
    const item = { title: "x", url: "/x", icon: "star" };

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        sidebar_items: Array(51).fill(item),
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        enabled_plugins: Array(201).fill("plugin"),
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        registry_config: { registries: {}, blockedMcps: Array(501).fill("x") },
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        default_home_agents: { ids: Array(101).fill("vmcp") },
      }).success,
    ).toBe(false);
  });

  it("rejects an oversized string in a sidebar item, enabled_plugins entry, blockedMcps entry, registries key, or default_home_agents id", () => {
    const longString = "x".repeat(501);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        sidebar_items: [{ title: longString, url: "/x", icon: "star" }],
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        enabled_plugins: [longString],
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        registry_config: { registries: {}, blockedMcps: [longString] },
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        registry_config: {
          registries: { [longString]: { enabled: true } },
          blockedMcps: [],
        },
      }).success,
    ).toBe(false);

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        default_home_agents: { ids: [longString] },
      }).success,
    ).toBe(false);
  });

  it("rejects an oversized registries record on registry_config", () => {
    // Regression: registries was the one sibling collection left uncapped.
    const registries = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`conn-${i}`, { enabled: true }]),
    );

    expect(
      ORGANIZATION_SETTINGS_UPDATE.inputSchema.safeParse({
        organizationId: "org-a",
        registry_config: { registries, blockedMcps: [] },
      }).success,
    ).toBe(false);
  });
});
