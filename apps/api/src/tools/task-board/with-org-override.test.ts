import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { withOrgOverride } from "./with-org-override";

const baseTool = {
  name: "FAKE_TOOL",
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
