import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { getSettings, setGlobalSettings } from "@/settings";
import { resolveConfig } from "@/settings/resolve-config";
import type { Settings } from "@/settings/types";
import type { StudioContext } from "@/core/studio-context";
import { withOrgOverride } from "./with-org-override";

/** A member of `org_admin_hq` somewhere, but the org the tool is standing in
 *  right now (`org_caller`) is not itself an admin org. */
function adminOrgElsewhereSettings(): Settings {
  const { settings } = resolveConfig(
    { port: "", home: "", localMode: false, skipMigrations: false },
    { STUDIO_ADMIN_ORG_IDS: "org_admin_hq" },
  );
  return { ...settings, databaseUrl: "", natsUrls: [] } as Settings;
}

const previousSettings = (() => {
  try {
    return getSettings();
  } catch {
    return null;
  }
})();
setGlobalSettings(adminOrgElsewhereSettings());
afterAll(() => {
  if (previousSettings) setGlobalSettings(previousSettings);
});

const baseTool = {
  name: "FAKE_TOOL",
  description: "List all task board items for the organization.",
  inputSchema: z.object({ id: z.string() }),
  execute: async (input: { id: string }, ctx: StudioContext) => ({
    input,
    orgId: ctx.organization?.id,
  }),
};

const ctx = {
  organization: { id: "org_caller" },
} as unknown as StudioContext;

/** Chainable stub of the exact `db.selectFrom(...).select(...).where(...)
 *  .where(...).executeTakeFirst()` shape `isTaskBoardAdminUser` calls — always
 *  resolves a row, standing in for "this user IS a member of `org_admin_hq`". */
const fakeMemberDb = {
  selectFrom: () => fakeMemberDb,
  select: () => fakeMemberDb,
  where: () => fakeMemberDb,
  executeTakeFirst: async () => ({ id: "member_1" }),
};

/** Belongs to the admin org `org_admin_hq`, but is currently standing in
 *  `org_not_admin` — a plain org, not the admin org itself. */
const memberElsewhereCtx = {
  organization: { id: "org_not_admin" },
  db: fakeMemberDb,
  storage: {
    taskBoardAnalytics: { resolveOrgRef: async () => ({ id: "org_target" }) },
  },
  auth: { user: { id: "user_1" } },
} as unknown as StudioContext;

describe("withOrgOverride", () => {
  it("advertises `org` on the wire schema without breaking the original", () => {
    const wrapped = withOrgOverride(baseTool);
    const schema = wrapped.inputSchema as z.ZodObject<z.ZodRawShape>;

    expect(Object.keys(schema.shape).sort()).toEqual(["id", "org"]);
    expect(schema.parse({ id: "a" })).toEqual({ id: "a" });
    expect(baseTool.inputSchema.shape).not.toHaveProperty("org");
  });

  it("tells the model the capability exists, in the description it reads first", () => {
    const wrapped = withOrgOverride(baseTool);

    // The parameter alone was not enough — see ORG_OVERRIDE_HINT.
    expect(wrapped.description).toStartWith(baseTool.description);
    expect(wrapped.description).toContain("org");
    // The model cannot learn which orgs it may name any other way.
    expect(wrapped.description).toContain("TASK_BOARD_ADMIN_ORG_LIST");
  });

  it("is a pass-through when no org is named", async () => {
    const wrapped = withOrgOverride(baseTool);

    expect(await wrapped.execute({ id: "a" }, ctx)).toEqual({
      input: { id: "a" },
      orgId: "org_caller",
    });
  });

  it("fails closed for a non-admin naming another org", async () => {
    const wrapped = withOrgOverride(baseTool);

    await expect(
      wrapped.execute({ id: "a", org: "other" } as never, ctx),
    ).rejects.toThrow(/Not allowed to act on another organization/);
  });

  it("fails closed for an admin-org member standing outside the admin org", async () => {
    const wrapped = withOrgOverride(baseTool);

    // Membership of `org_admin_hq` alone must not unlock the override.
    await expect(
      wrapped.execute({ id: "a", org: "other" } as never, memberElsewhereCtx),
    ).rejects.toThrow(/Not allowed to act on another organization/);
  });
});
