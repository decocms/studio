import { describe, expect, it, mock } from "bun:test";
import type { PlanObjective } from "@decocms/shared/organization/schema";
import { ORGANIZATION_PLAN_OBJECTIVE_SET } from "./plan-objective-set";

function makeCtx(
  organization: { id: string } | undefined,
  auth: Record<string, unknown> = { user: { id: "user-1" } },
) {
  const setPlanObjective = mock(
    async (organizationId: string, objective: PlanObjective | null) => ({
      organizationId,
      plan_objective: objective,
    }),
  );
  const ctx = {
    auth,
    organization,
    access: { check: mock(async () => {}) },
    storage: { organizationSettings: { setPlanObjective } },
  } as unknown as Parameters<typeof ORGANIZATION_PLAN_OBJECTIVE_SET.handler>[1];
  return { ctx, setPlanObjective };
}

const parse = (statement: unknown) =>
  ORGANIZATION_PLAN_OBJECTIVE_SET.inputSchema.safeParse({ statement });

describe("ORGANIZATION_PLAN_OBJECTIVE_SET", () => {
  it("writes the trimmed goal with the caller as author", async () => {
    const { ctx, setPlanObjective } = makeCtx({ id: "org-a" });
    const input = parse("  Sell more on mobile.  ");
    if (!input.success) throw input.error;

    const result = await ORGANIZATION_PLAN_OBJECTIVE_SET.handler(
      input.data,
      ctx,
    );

    const [orgId, written] = setPlanObjective.mock.calls[0] ?? [];
    expect(orgId).toBe("org-a");
    expect(written).toMatchObject({
      statement: "Sell more on mobile.",
      updated_by: "user-1",
    });
    expect(Number.isNaN(Date.parse(written?.updated_at ?? ""))).toBe(false);
    expect(Object.keys(written ?? {}).sort()).toEqual([
      "statement",
      "updated_at",
      "updated_by",
    ]);
    expect(result.plan_objective).toEqual(written ?? null);
  });

  it("clears the goal with null", async () => {
    const { ctx, setPlanObjective } = makeCtx({ id: "org-a" });

    const result = await ORGANIZATION_PLAN_OBJECTIVE_SET.handler(
      { statement: null },
      ctx,
    );

    expect(setPlanObjective.mock.calls[0]).toEqual(["org-a", null]);
    expect(result).toEqual({ plan_objective: null });
  });

  it("credits the key's user when called with an API key", async () => {
    const { ctx, setPlanObjective } = makeCtx(
      { id: "org-a" },
      { apiKey: { id: "key-1", userId: "user-2" } },
    );

    await ORGANIZATION_PLAN_OBJECTIVE_SET.handler({ statement: "Goal" }, ctx);

    expect(setPlanObjective.mock.calls[0]?.[1]?.updated_by).toBe("user-2");
  });

  it("fails closed without an organization", async () => {
    const { ctx, setPlanObjective } = makeCtx(undefined);

    await expect(
      ORGANIZATION_PLAN_OBJECTIVE_SET.handler({ statement: "Goal" }, ctx),
    ).rejects.toThrow(/organization scope/i);
    expect(setPlanObjective).not.toHaveBeenCalled();
  });

  it("rejects an empty, blank, oversized or missing goal", () => {
    expect(parse("").success).toBe(false);
    expect(parse("   ").success).toBe(false);
    expect(parse("x".repeat(281)).success).toBe(false);
    expect(parse(undefined).success).toBe(false);
    expect(parse(42).success).toBe(false);
    expect(parse("x".repeat(280)).success).toBe(true);
  });
});
