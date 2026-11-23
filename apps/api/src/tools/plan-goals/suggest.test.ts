import { describe, expect, it, mock } from "bun:test";
import { PLAN_GOAL_SUGGEST } from "./suggest";

function makeCtx(flags: Record<string, unknown> | null) {
  const get = mock(async () => (flags ? { flags } : null));
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a" },
    access: { check: mock(async () => {}), getRole: () => "member" },
    storage: { organizationSettings: { get } },
  } as unknown as Parameters<typeof PLAN_GOAL_SUGGEST.handler>[1];
  return { ctx, get };
}

describe("PLAN_GOAL_SUGGEST", () => {
  it("refuses unless the Plan page is on", async () => {
    for (const flags of [null, {}, { plan_page_enabled: false }]) {
      const { ctx, get } = makeCtx(flags);
      await expect(PLAN_GOAL_SUGGEST.handler({}, ctx)).rejects.toThrow(
        /not enabled/,
      );
      expect(get).toHaveBeenCalledWith("org-a");
    }
  });
});
