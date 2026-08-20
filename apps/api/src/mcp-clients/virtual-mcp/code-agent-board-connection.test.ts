import { describe, expect, test } from "bun:test";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import { codeAgentBoardConnection } from "./index";

type VmcpArg = Pick<
  VirtualMCPEntity,
  "organization_id" | "metadata" | "connections"
>;

function vmcp(overrides: Record<string, unknown> = {}): VmcpArg {
  return {
    organization_id: "org_1",
    metadata: { githubRepo: { url: "https://github.com/acme/widget" } },
    connections: [{ connection_id: "conn_github" }],
    ...overrides,
  } as VmcpArg;
}

describe("codeAgentBoardConnection", () => {
  test("grafts a scoped SELF connection onto a coding agent", () => {
    const conn = codeAgentBoardConnection(vmcp());
    expect(conn).not.toBeNull();
    expect(conn?.connection_id).toBe(WellKnownOrgMCPId.SELF("org_1"));
    expect(conn?.selected_tools).toEqual([
      "TASK_BOARD_ITEM_LIST",
      "TASK_BOARD_ITEM_CREATE",
      "TASK_BOARD_ITEM_UPDATE",
      "TASK_BOARD_COMMENT_CREATE",
    ]);
    // Never REVIEW_DECISION or PROMOTE — an agent must not sign off on its own work.
    expect(conn?.selected_tools).not.toContain("TASK_BOARD_REVIEW_DECISION");
    expect(conn?.selected_tools).not.toContain(
      "TASK_BOARD_PROMOTE_TO_PRODUCTION",
    );
  });

  test("skips an agent without a github repo (no checkout, not a coding agent)", () => {
    expect(codeAgentBoardConnection(vmcp({ metadata: {} }))).toBeNull();
    expect(
      codeAgentBoardConnection(vmcp({ metadata: { githubRepo: null } })),
    ).toBeNull();
  });

  test("skips a well-known agent that resolves with no organization", () => {
    expect(codeAgentBoardConnection(vmcp({ organization_id: "" }))).toBeNull();
  });

  test("does not double-graft when the agent already declares SELF", () => {
    const selfId = WellKnownOrgMCPId.SELF("org_1");
    const conn = codeAgentBoardConnection(
      vmcp({
        connections: [
          { connection_id: "conn_github" },
          { connection_id: selfId },
        ],
      }),
    );
    expect(conn).toBeNull();
  });
});
