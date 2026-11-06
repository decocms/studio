/**
 * An automation whose agent is gone stops firing: deleting the agent turns
 * its automations off, and a fire that finds the agent missing (an automation
 * orphaned before that) turns the automation off and starts no run.
 */

import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface AutomationGet {
  automation: { id: string; active: boolean };
}
interface RunResult {
  threadId?: string;
  error?: string;
  skipped?: string;
}

const messages = [
  { role: "user", parts: [{ type: "text", text: "Summarize the week." }] },
];

test.describe("automations of a deleted agent", () => {
  test("deleting the agent turns its automations off", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(page.context().request, orgSlug, name, args);

    const { item: agent } = await call<{ item: { id: string } }>(
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "Weekly agent", connections: [] } },
    );
    const { id } = await call<{ id: string }>("AUTOMATION_CREATE", {
      name: "Weekly summary",
      virtual_mcp_id: agent.id,
      messages,
    });
    expect(
      (await call<AutomationGet>("AUTOMATION_GET", { id })).automation.active,
    ).toBe(true);

    await call("COLLECTION_VIRTUAL_MCP_DELETE", { id: agent.id });

    expect(
      (await call<AutomationGet>("AUTOMATION_GET", { id })).automation.active,
    ).toBe(false);
  });

  test("a fire on a missing agent turns the automation off without a run", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(page.context().request, orgSlug, name, args);

    const { id } = await call<{ id: string }>("AUTOMATION_CREATE", {
      name: "Orphaned summary",
      virtual_mcp_id: "vir_agent_that_was_deleted",
      messages,
    });

    const result = await call<RunResult>("AUTOMATION_RUN", { id });
    expect(result).toEqual({ skipped: "agent_not_found" });
    expect(
      (await call<AutomationGet>("AUTOMATION_GET", { id })).automation.active,
    ).toBe(false);
  });
});
