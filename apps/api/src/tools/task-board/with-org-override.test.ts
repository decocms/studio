import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { withOrgOverride } from "./with-org-override";

const baseTool = {
  name: "FAKE_TOOL",
  description: "List all task board items for the organization.",
  inputSchema: z.object({ id: z.string() }),
  execute: async (input: { id: string }, ctx: StudioContext) => ({
    input,
    orgId: ctx.organization?.id,
  }),
};

const ctx = { organization: { id: "org_caller" } } as StudioContext;

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
});
