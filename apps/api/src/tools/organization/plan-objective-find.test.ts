import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_PLAN_OBJECTIVE_FIND } from "./plan-objective-find";

function makeCtx(flags: Record<string, unknown> | null) {
  const get = mock(async () => (flags ? { flags } : null));
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a" },
    access: { check: mock(async () => {}) },
    storage: { organizationSettings: { get } },
  } as unknown as Parameters<
    typeof ORGANIZATION_PLAN_OBJECTIVE_FIND.handler
  >[1];
  return { ctx, get };
}

describe("ORGANIZATION_PLAN_OBJECTIVE_FIND", () => {
  it("refuses unless the Plan page is on", async () => {
    for (const flags of [null, {}, { plan_page_enabled: false }]) {
      const { ctx, get } = makeCtx(flags);
      await expect(
        ORGANIZATION_PLAN_OBJECTIVE_FIND.handler({}, ctx),
      ).rejects.toThrow(/not enabled/);
      expect(get).toHaveBeenCalledWith("org-a");
    }
  });
});
