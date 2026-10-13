/**
 * The `board_column_transition` trigger over the wire: an automation gets
 * one, reads it back with its column, and a trigger without a column is
 * refused. Firing it needs a run, which this tier does not have; the sweep
 * is covered at the integration tier
 * (`board-column-transition-sweeper.integration.test.ts`).
 */

import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface Trigger {
  id: string;
  type: string;
  column_key: string | null;
  from: { kind: string; statuses?: string[] } | null;
}

test.describe("automation board column trigger", () => {
  test("an automation runs on cards entering a column", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    const { id } = await call<{ id: string }>("AUTOMATION_CREATE", {
      name: "Triage new work",
      virtual_mcp_id: `decopilot_${orgId}`,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Triage the card." }] },
      ],
    });

    const added = await call<Trigger>("AUTOMATION_TRIGGER_ADD", {
      automation_id: id,
      type: "board_column_transition",
      column_key: "qa",
      from: { kind: "statuses", statuses: ["in_review"] },
    });
    expect(added.type).toBe("board_column_transition");

    const { automation } = await call<{
      automation: { triggers: Trigger[] };
    }>("AUTOMATION_GET", { id });
    expect(automation.triggers).toEqual([
      expect.objectContaining({
        id: added.id,
        type: "board_column_transition",
        column_key: "qa",
        from: { kind: "statuses", statuses: ["in_review"] },
      }),
    ]);

    await expect(
      call("AUTOMATION_TRIGGER_ADD", {
        automation_id: id,
        type: "board_column_transition",
      }),
    ).rejects.toThrow(/column_key is required/);
    await expect(
      call("AUTOMATION_TRIGGER_ADD", {
        automation_id: id,
        type: "board_column_transition",
        column_key: "not_a_column",
      }),
    ).rejects.toThrow();
  });
});
