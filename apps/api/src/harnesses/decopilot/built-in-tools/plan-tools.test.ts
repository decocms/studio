import { describe, expect, test } from "bun:test";
import { createPlanTools } from "./plan-tools";

function ctxWith(get: () => Promise<unknown>) {
  return { storage: { organizationSettings: { get } } } as never;
}

describe("createPlanTools", () => {
  test("registers the store-goal writer under the name the Plan prompt calls", async () => {
    const tools = await createPlanTools(
      ctxWith(async () => ({ flags: { plan_page_enabled: true } })),
      "org_1",
    );
    expect(Object.keys(tools)).toEqual(["ORGANIZATION_PLAN_OBJECTIVE_SET"]);
  });

  test("leaves it out while the Plan page is off", async () => {
    for (const settings of [
      null,
      { flags: {} },
      { flags: { plan_page_enabled: false } },
    ]) {
      expect(
        await createPlanTools(
          ctxWith(async () => settings),
          "org_1",
        ),
      ).toEqual({});
    }
  });

  test("leaves it out when the settings read fails, instead of failing the turn", async () => {
    const tools = await createPlanTools(
      ctxWith(() => Promise.reject(new Error("db down"))),
      "org_1",
    );
    expect(tools).toEqual({});
  });
});
