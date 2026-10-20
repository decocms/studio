import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { ownRepo, resolveScope, TASK_BOARD_DELIVERY } from "./analytics";

const nonAdminCtx = {
  organization: { id: "org-1", slug: "acme" },
  auth: { user: { id: "user-1" } },
  db: undefined,
} as unknown as StudioContext;

describe("task board analytics input schema", () => {
  test("rejects a non-ISO from/to instead of crashing downstream", () => {
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({ from: "not-a-date" }).success,
    ).toBe(false);
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({ to: "2024-99-99" }).success,
    ).toBe(false);
  });

  test("accepts a valid ISO range, with or without an offset", () => {
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({
        from: "2024-01-01T00:00:00Z",
        to: "2024-01-31T00:00:00+02:00",
      }).success,
    ).toBe(true);
  });

  test("rejects a `from` after `to` instead of silently returning nothing", () => {
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({
        from: "2024-02-01T00:00:00Z",
        to: "2024-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("a `to` in an earlier offset than `from`'s same-instant UTC is still fine", () => {
    expect(
      TASK_BOARD_DELIVERY.inputSchema.safeParse({
        from: "2024-01-01T00:00:00Z",
        to: "2024-01-01T02:00:00+02:00",
      }).success,
    ).toBe(true);
  });
});

describe("resolveScope cross-tenant guard", () => {
  test("a non-admin caller asking for another named org is rejected, not routed to that org's data", async () => {
    await expect(
      resolveScope(
        { org: "some-other-org" },
        nonAdminCtx,
        "TASK_BOARD_DELIVERY",
      ),
    ).rejects.toThrow(
      "Not allowed to read another organization's task board analytics",
    );
  });

  test('a non-admin caller asking for "all" gets their own org\'s data, not an error', async () => {
    const { query, org } = await resolveScope(
      { org: "all" },
      nonAdminCtx,
      "TASK_BOARD_DELIVERY",
    );
    expect(org).toBe("acme");
    expect(query.orgIds).toEqual(["org-1"]);
  });

  test("omitting org scopes to the caller's own org", async () => {
    const { query, org } = await resolveScope(
      {},
      nonAdminCtx,
      "TASK_BOARD_DELIVERY",
    );
    expect(org).toBe("acme");
    expect(query.orgIds).toEqual(["org-1"]);
  });
});

describe("ownRepo", () => {
  const project = (
    id: string,
    repo: string | null,
    metadata: Record<string, unknown> = {},
  ) =>
    ({
      id,
      metadata: {
        ...metadata,
        ...(repo
          ? {
              repository: {
                url: `https://github.com/${repo}`,
                owner: repo.split("/")[0],
                name: repo.split("/")[1],
              },
            }
          : {}),
      },
    }) as unknown as VirtualMCPEntity;
  const ctxWith = (projects: VirtualMCPEntity[]) =>
    ({
      storage: { virtualMcps: { list: async () => projects } },
    }) as unknown as StudioContext;

  const north = project("vir_north", "Acme/Store");

  test("names the repository the project alone pins", async () => {
    const ctx = ctxWith([north, project("vir_mkt", "acme/site")]);
    expect(await ownRepo(ctx, "org-1", north)).toBe("acme/store");
  });

  test("names none when a sibling pins the same repository", async () => {
    const ctx = ctxWith([north, project("vir_south", "acme/store")]);
    expect(await ownRepo(ctx, "org-1", north)).toBeNull();
  });

  test("a dev agent on the same repository is not a sibling", async () => {
    const dev = project("vir_dev", "acme/store", { liveAgentId: "vir_north" });
    expect(await ownRepo(ctxWith([north, dev]), "org-1", north)).toBe(
      "acme/store",
    );
  });

  test("a repo-less project has none", async () => {
    const bare = project("vir_bare", null);
    expect(await ownRepo(ctxWith([bare]), "org-1", bare)).toBeNull();
  });
});
